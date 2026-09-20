"""Closed-loop regressions for observation-only, fixed-camera support passes."""
import math
import unittest
from types import SimpleNamespace

import numpy as np

from agents.surveillance import point_ne, support_waypoint
from flight_policy import COORDINATED_ALGORITHM, normalize_flight_policy
from geo import ne_to_ll
from graph_search import Terrain, angle_delta, move_surveillance_drone
from plane_shadow import PlaneShadow
from sim.types import Arena, VehicleState
from test_graph_search import profile
from world import WorldModel


SENSOR = {"pitchDeg": -8.021409, "hfovDeg": 68.984119,
          "vfovDeg": 42.261117, "farClipM": 1500.}


class PlaneShadowTests(unittest.TestCase):
    def setUp(self):
        p = profile()
        # Flat open water isolates camera geometry from terrain/arena edges.
        p["halfM"] = 3000.
        p["grid"].update(cellM=1000., xMin=-3000., yMin=-3000.)
        p["sensors"]["plane"].update(SENSOR)
        self.terrain = Terrain(p)

    def flight(self, width, old_rectangle=False):
        policy = normalize_flight_policy({"supportOffsetM": width})
        controller = PlaneShadow()
        drone = {"id": "plane", "x": 0., "y": -1000., "z": 120., "heading": 0.}
        leg, visible, nearest = 0, 0, math.inf
        phases = set()
        for t in range(300):
            # This is a noise-free observer fixture. The controller receives
            # only its supplied observation and estimated velocity.
            observation, velocity = np.array([3. * t, 0.]), np.array([3., 0.])
            own = np.array([drone["x"], drone["y"]])
            if old_rectangle:
                # Frozen prior policy: retain its four corners for a paired
                # regression, without coarse grid rounding favoring the fix.
                lead = min(policy["lookaheadS"], np.linalg.norm(observation - own) / 15.)
                center = observation + velocity * lead
                def corner(index):
                    a, b = ((-1,-1), (1,-1), (1,1), (-1,1))[index % 4]
                    return center + np.array([a * max(400., width * 1.8), -b * width])
                goal = corner(leg)
                if np.linalg.norm(goal - own) < 100.:
                    leg += 1
                    goal = corner(leg)
            else:
                goal = controller.waypoint(own, drone["heading"], 15., 120., observation,
                                           velocity, policy, SENSOR)
                phases.add(controller.phase)
            heading = drone["heading"]
            distance = move_surveillance_drone(self.terrain, drone, goal, 1.)
            self.assertAlmostEqual(distance, 15., places=6)
            self.assertLessEqual(abs(angle_delta(drone["heading"], heading)), 15.000001)
            nearest = min(nearest, float(np.linalg.norm(observation - [drone["x"], drone["y"]])))
            visible += bool(self.terrain.camera_mask(drone, "plane", [observation])[0])
        return visible / 300., nearest, phases

    def test_moving_offset_passes_improve_real_fov_contact_and_avoid_overhead(self):
        for width in (100., 350.):
            with self.subTest(supportOffsetM=width):
                before, _, _ = self.flight(width, old_rectangle=True)
                after, closest, phases = self.flight(width)
                self.assertGreater(after, before + .10)
                self.assertGreater(after, .30)
                self.assertGreater(closest, 250.)
                self.assertEqual(phases, {"observe", "reposition"})

    def test_camera_mount_and_sea_height_change_when_plane_turns_away(self):
        policy = normalize_flight_policy()
        kwargs = dict(position=(0., -350.), heading=0., speed=15., estimate=(0., 0.),
                      velocity=(0., 0.), policy=policy)
        low, high, steep = PlaneShadow(), PlaneShadow(), PlaneShadow()
        low.waypoint(**kwargs, height=60., sensor=SENSOR)
        high.waypoint(**kwargs, height=200., sensor=SENSOR)
        steep.waypoint(**kwargs, height=200., sensor=dict(SENSOR, pitchDeg=-35.))
        self.assertEqual(low.phase, "observe")
        self.assertEqual(high.phase, "reposition")
        self.assertEqual(steep.phase, "observe")

    def test_runtime_uses_same_geometry_in_true_north_east_and_requires_live_sea_height(self):
        arena = Arena(72., -94., 3250., heading_offset_deg=-49.8)
        world = WorldModel(algorithm=COORDINATED_ALGORITHM, arena=arena)
        world.track = SimpleNamespace(lat=arena.origin_lat, lon=arena.origin_lon, vn=0., ve=3.)
        me = VehicleState("plane", 1, "plane", *ne_to_ll(-1000., 0., arena.origin_lat, arena.origin_lon),
                          alt=90., alt_msl=120., mavlink=True, heading=0., groundspeed=15.)
        goal = support_waypoint(world, me, PlaneShadow())
        north, east = point_ne(world, *goal)
        x, y = PlaneShadow().waypoint((0., -1000.), 0., 15., 120., (0., 0.), (3., 0.),
                                     world.flight_policy, SENSOR)
        self.assertAlmostEqual(east, x, delta=.01)
        self.assertAlmostEqual(north, y, delta=.01)
        me.alt_msl = None
        self.assertIsNone(support_waypoint(world, me, PlaneShadow()))


if __name__ == "__main__":
    unittest.main()
