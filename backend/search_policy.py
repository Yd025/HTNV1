"""Deterministic, observation-only first-detection policies for the local stand-in.

Call ``commands`` only while no target has been detected. Its inputs contain
own-fleet poses, sensor mounts and elapsed time; no target position or trajectory
is available. Straight-line navigation is valid only for an obstacle-free arena.
"""

from __future__ import annotations

import math
from functools import lru_cache

from geo import bearing_deg, haversine_m, ll_to_ne, ne_to_ll
from sim.local_sitl import CRUISE_ALT, SPEED
from sim.target import _fov_params, _in_fov
from sim.types import Arena, Command, VehicleState


@lru_cache(maxsize=8)
def _grid_geometry(origin_lat: float, origin_lon: float, half: float, size: int):
    width = 2.0 * half / size
    cells = tuple((-half + (r + 0.5) * width, -half + (c + 0.5) * width)
                  for r in range(size) for c in range(size))
    points = tuple(ne_to_ll(n, e, origin_lat, origin_lon) for n, e in cells)
    max_range = max(_fov_params(kind)["range_m"] for kind in ("plane", "copter", "rover"))
    # Cache exact stand-in geographic distances; scoring then needs no trig.
    neighbors = []
    for lat, lon in points:
        nearby = []
        for index, (other_lat, other_lon) in enumerate(points):
            distance = haversine_m(lat, lon, other_lat, other_lon)
            if distance <= max_range:
                nearby.append((index, distance, bearing_deg(lat, lon, other_lat, other_lon)))
        neighbors.append(tuple(nearby))
    return cells, points, tuple(neighbors)


class SearchPlanner:
    """A systematic baseline or a greedy negative-observation belief search.

    Belief is an approximate grid distribution, not a calibrated boat tracker.
    Greedy scoring maximizes visible posterior mass per transit-plus-dwell time;
    it has no global-optimality guarantee. Both policies use the same sensors.
    Detection probability is per source per sampled call (the training runner
    uses one-second samples); change it if the sensor observation cadence changes.
    """

    def __init__(self, arena: Arena, algorithm: str = "lawnmower", grid_size: int = 10,
                 scan_period_s: float = 60.0, detection_probability: float = 1.0):
        if arena.no_fly:
            raise ValueError("SearchPlanner supports obstacle-free local arenas only; no_fly is not supported")
        if algorithm not in ("lawnmower", "belief_greedy"):
            raise ValueError("algorithm must be lawnmower or belief_greedy")
        if not isinstance(grid_size, int) or isinstance(grid_size, bool) or grid_size < 2:
            raise ValueError("grid_size must be an integer of at least 2")
        if not math.isfinite(arena.half_m) or arena.half_m <= 0:
            raise ValueError("arena.half_m must be positive and finite")
        if not math.isfinite(scan_period_s) or scan_period_s <= 0:
            raise ValueError("scan_period_s must be positive and finite")
        if not math.isfinite(detection_probability) or not 0 <= detection_probability <= 1:
            raise ValueError("detection_probability must be between 0 and 1")
        self.algorithm = algorithm
        self.grid_size = grid_size
        self.scan_period_s = scan_period_s
        self.detection_probability = detection_probability
        self._origin = (arena.origin_lat, arena.origin_lon)
        self._cell_width = 2.0 * arena.half_m / grid_size
        self.cells, self._points, self._neighbors = _grid_geometry(*self._origin, arena.half_m, grid_size)
        self._mounts = tuple(arena.towers)
        self._initial_headings = {mount.vehicle_id: mount.heading for mount in self._mounts}
        self._belief = [1.0 / len(self.cells)] * len(self.cells)
        self._last_elapsed: float | None = None
        self._fleet_ids: tuple[str, ...] = ()
        self._routes: dict[str, list[int]] = {}
        self._route_positions: dict[str, int] = {}
        self._goals: dict[str, int] = {}
        self._planned_at: dict[str, float] = {}

    @property
    def belief(self) -> tuple[float, ...]:
        """Read-only posterior mass, in the same row-major order as ``cells``."""
        return tuple(self._belief)

    def commands(self, vehicles: list[VehicleState], elapsed_s: float) -> list[Command]:
        if not math.isfinite(elapsed_s) or elapsed_s < 0:
            raise ValueError("elapsed_s must be nonnegative and finite")
        if self._last_elapsed is not None and elapsed_s < self._last_elapsed:
            raise ValueError("elapsed_s cannot go backwards; create a planner for each episode")
        mobile = sorted((v for v in vehicles if v.connected and v.vehicle_class != "tower"),
                        key=lambda v: (-SPEED[v.vehicle_class], v.vehicle_id))
        if len(mobile) > len(self.cells):
            raise ValueError("grid needs at least one cell per mobile vehicle")
        if self.algorithm == "belief_greedy" and elapsed_s != self._last_elapsed:
            self._update_belief(vehicles, elapsed_s)
        self._last_elapsed = elapsed_s
        if tuple(v.vehicle_id for v in mobile) != self._fleet_ids:
            self._configure_routes(mobile)
        output = []
        for mount in sorted(self._mounts, key=lambda m: m.vehicle_id):
            heading = math.radians((self._initial_headings[mount.vehicle_id]
                                    + elapsed_s * 360.0 / self.scan_period_s) % 360.0)
            north, east = ll_to_ne(mount.lat, mount.lon, *self._origin)
            # This is a camera aim point, not a navigation destination.
            lat, lon = ne_to_ll(north + 100.0 * math.cos(heading),
                               east + 100.0 * math.sin(heading), *self._origin)
            output.append(Command(mount.vehicle_id, "look_at", lat, lon))
        for vehicle in mobile:
            vid = vehicle.vehicle_id
            goal = self._goals.get(vid)
            reached = goal is not None and haversine_m(vehicle.lat, vehicle.lon, *self._points[goal]) < 9.0
            if self.algorithm == "lawnmower":
                if reached:
                    self._route_positions[vid] = (self._route_positions[vid] + 1) % len(self._routes[vid])
                goal = self._routes[vid][self._route_positions[vid]]
            elif goal is None or reached or elapsed_s - self._planned_at.get(vid, -math.inf) >= 15.0:
                reserved = {index for other, index in self._goals.items() if other != vid}
                goal = self._greedy_goal(vehicle, reserved, goal)
                self._planned_at[vid] = elapsed_s
            self._goals[vid] = goal
            lat, lon = self._points[goal]
            output.append(Command(vid, "goto", lat, lon, CRUISE_ALT[vehicle.vehicle_class]))
        return output

    def _configure_routes(self, mobile: list[VehicleState]) -> None:
        self._fleet_ids = tuple(v.vehicle_id for v in mobile)
        self._goals.clear()
        self._planned_at.clear()
        self._routes.clear()
        self._route_positions.clear()
        if not mobile:
            return
        snake = [r * self.grid_size + c for r in range(self.grid_size)
                 for c in (range(self.grid_size) if r % 2 == 0 else reversed(range(self.grid_size)))]
        # Disjoint contiguous parts of a serpentine route, proportional to rough
        # sweep capacity (speed x sensor half-width); each craft gets >= 1 cell.
        weights = []
        for vehicle in mobile:
            params = _fov_params(vehicle.vehicle_class)
            half_width = params["range_m"] * math.sin(math.radians(min(90, params["half_fov_deg"])))
            weights.append(SPEED[vehicle.vehicle_class] * half_width)
        spare = len(snake) - len(mobile)
        counts = [1 + int(spare * weight / sum(weights)) for weight in weights]
        for index in range(len(snake) - sum(counts)):
            counts[index % len(mobile)] += 1
        offset = 0
        for vehicle, count in zip(mobile, counts):
            route = snake[offset:offset + count]
            self._routes[vehicle.vehicle_id] = route
            self._route_positions[vehicle.vehicle_id] = min(
                range(len(route)), key=lambda i: haversine_m(vehicle.lat, vehicle.lon, *self._points[route[i]]))
            offset += count

    def _update_belief(self, vehicles: list[VehicleState], elapsed_s: float) -> None:
        dt = 0.0 if self._last_elapsed is None else elapsed_s - self._last_elapsed
        # Reflecting nearest-neighbor diffusion is a deliberately mild motion
        # approximation (6 m/s scale), preserving mass including at boundaries.
        fraction = min(0.25, dt * 6.0 / self._cell_width)
        updated = [mass * (1.0 - fraction) for mass in self._belief]
        for index, mass in enumerate(self._belief):
            row, col = divmod(index, self.grid_size)
            neighbors = [r * self.grid_size + c for r, c in
                         ((row - 1, col), (row + 1, col), (row, col - 1), (row, col + 1))
                         if 0 <= r < self.grid_size and 0 <= c < self.grid_size]
            updated[index] += mass * fraction * (4 - len(neighbors)) / 4.0
            for neighbor in neighbors:
                updated[neighbor] += mass * fraction / 4.0
        sensors = {}
        for vehicle in vehicles:
            if vehicle.vehicle_class != "tower" and vehicle.connected:
                params = _fov_params(vehicle.vehicle_class)
                sensors[vehicle.vehicle_id] = (vehicle.lat, vehicle.lon, vehicle.heading,
                                               params["range_m"], params["half_fov_deg"])
        for mount in self._mounts:
            sensors[mount.vehicle_id] = (mount.lat, mount.lon, mount.heading, mount.range_m, mount.fov_deg / 2.0)
        # Only sampled views are evidence: no assumed observation along paths
        # between ticks. Independent misses compound when sensors overlap.
        for lat, lon, heading, sensor_range, half_fov in sensors.values():
            for index, (tlat, tlon) in enumerate(self._points):
                if _in_fov(lat, lon, heading, tlat, tlon, sensor_range, half_fov, 0.0)[1]:
                    updated[index] *= 1.0 - self.detection_probability
        total = sum(updated)
        # Complete exclusion signals grid/model mismatch; restart exploration
        # rather than dividing by zero or creating an all-zero distribution.
        self._belief = ([mass / total for mass in updated] if total > 1e-15
                        else [1.0 / len(updated)] * len(updated))

    def _greedy_goal(self, vehicle: VehicleState, reserved: set[int], old_goal: int | None) -> int:
        params = _fov_params(vehicle.vehicle_class)
        choices = [index for index in range(len(self.cells)) if index not in reserved and index != old_goal]
        if not choices:
            choices = [index for index in range(len(self.cells)) if index not in reserved]
        best, best_score = choices[0], -1.0
        for index in choices:
            lat, lon = self._points[index]
            heading = bearing_deg(vehicle.lat, vehicle.lon, lat, lon)
            mass = sum(self._belief[other] * (0.2 if other in reserved else 1.0)
                       for other, distance, bearing in self._neighbors[index]
                       if distance <= params["range_m"] and
                       (params["half_fov_deg"] >= 170 or
                        abs((bearing - heading + 180.0) % 360.0 - 180.0) <= params["half_fov_deg"]))
            transit = haversine_m(vehicle.lat, vehicle.lon, lat, lon) / SPEED[vehicle.vehicle_class]
            score = mass / (transit + 6.0)
            if score > best_score:
                best, best_score = index, score
        return best
