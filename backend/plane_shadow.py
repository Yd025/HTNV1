"""Moving surveillance passes for an aircraft with a fixed forward camera.

Only an observed/predicted contact and ownship state enter this controller.
A faster aircraft cannot keep a slower vessel ahead forever: it makes an
offset inward pass, turns away before the camera's steep-down blind area,
then repositions for the next pass. A quad supplies custody during turns.
Coordinates are Cartesian x/east, y/north; headings are clockwise from +y.
This geometric controller does not model terrain, wind, roll or autopilot lag.
"""
from __future__ import annotations

import math


class PlaneShadow:
    def __init__(self) -> None:
        self.phase = "observe"
        self.side = 0

    def reset(self) -> None:
        self.phase = "observe"
        self.side = 0

    def waypoint(self, position, heading, speed, height, estimate, velocity,
                 policy, sensor, turn_rate=15.) -> tuple[float, float]:
        """Return a short heading waypoint, never a point above the vessel.

        The camera geometry sets the minimum viewing distance; the learned
        offset controls the oblique approach and the width of repositioning.
        Hysteresis keeps noisy observations from reversing the turn each tick.
        """
        speed = max(1., float(speed))
        turn_radius = speed / math.radians(max(1., turn_rate))
        depression = max(1., -float(sensor.get("pitchDeg", -8.)))
        half_horizontal = float(sensor.get("hfovDeg", 69.)) / 2.
        half_vertical = float(sensor.get("vfovDeg", 42.3)) / 2.
        sea_height = max(1., float(height) - 1.5)
        # Leave a margin inside both image edges, including an oblique pass's
        # shorter forward projection. Do not learn away this physical bound.
        offset = float(policy["supportOffsetM"])
        base_near = sea_height / math.tan(math.radians(min(80., depression + half_vertical * .85)))
        pass_angle = min(half_horizontal * .72, math.degrees(math.atan2(offset, max(250., base_near * 2.))))
        pass_angle = max(0., pass_angle)
        near = base_near / max(.2, math.cos(math.radians(pass_angle)))
        turn_at = near + 2. * turn_radius
        boresight = sea_height / math.tan(math.radians(min(80., depression)))
        far = float(sensor.get("farClipM", 1500.)) * .78
        outer = max(turn_at + max(180., offset), min(far, boresight))
        # The prediction is bounded so guidance does not aim far beyond the
        # actual observation merely because training selected a long lead.
        distance = math.hypot(estimate[0] - position[0], estimate[1] - position[1])
        lead = min(float(policy["lookaheadS"]), 8., distance / speed)
        contact = (estimate[0] + velocity[0] * lead, estimate[1] + velocity[1] * lead)
        dx, dy = contact[0] - position[0], contact[1] - position[1]
        distance = math.hypot(dx, dy)
        bearing = math.degrees(math.atan2(dx, dy)) % 360.
        if not self.side:
            delta = (bearing - heading + 180.) % 360. - 180.
            # Continue the shortest initial turn; retain its direction across
            # future passes to avoid a noisy left/right choice on every tick.
            self.side = 1 if delta >= 0. else -1
        if self.phase == "observe" and distance <= turn_at:
            self.phase = "reposition"
        elif self.phase == "reposition" and distance >= outer:
            self.phase = "observe"
        # On a viewing pass the estimate stays safely inside horizontal FOV.
        # Outbound flight points away at an angle, leaving lateral separation
        # for the next inbound turn rather than crossing the contact overhead.
        angle = pass_angle if self.phase == "observe" else 140.
        desired = math.radians(bearing + self.side * angle)
        reach = max(220., 12. * speed, 3. * turn_radius)
        return (position[0] + reach * math.sin(desired),
                position[1] + reach * math.cos(desired))
