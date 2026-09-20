"""Coordinated synthetic observation association preserves independent evidence."""
import unittest

from graph_search import Observation, TowerMission


def hit(source, timestamp, point=(0., 0.), confidence=.9):
    return Observation(source, point, timestamp, 8., confidence)


class CoordinatedAssociationTests(unittest.TestCase):
    def test_rejected_clutter_does_not_discard_valid_same_frame_return(self):
        mission = TowerMission(any_sensor=True)
        mission.update([hit("quad", 0)], 0)
        mission.update([hit("quad", 5, (5., 0.))], 5)
        clutter = hit("quad", 10, (1000., 1000.), .95)
        genuine = hit("quad", 10, (10., 0.))

        mission.update([clutter, genuine, genuine], 10)

        self.assertEqual(mission.accepted, [genuine])
        self.assertEqual(mission.last_observed, 10)
        self.assertEqual(mission.receiver_confirmed_sources, ["quad"])
        self.assertEqual(mission.rejected, 2)
        # Neither another candidate nor a duplicate can reuse that sensor frame.
        mission.update([hit("quad", 10, (11., 0.)), genuine], 10)
        self.assertEqual(mission.accepted, [])
        self.assertEqual(mission.receiver_confirmed_sources, [])

    def test_unrelated_clutter_cannot_replace_compatible_pending_evidence(self):
        mission = TowerMission(any_sensor=True)
        mission.update([hit("quad", 0), hit("tower-1", 0, (1000., 1000.))], 0)
        genuine = hit("quad", 5, (5., 0.))

        mission.update([genuine, hit("tower-1", 5, (-1000., 1000.))], 5)

        self.assertEqual(mission.acquired_at, 5)
        self.assertEqual(mission.acquired_source, "quad")
        self.assertEqual(mission.accepted, [genuine])
        self.assertEqual(mission.receiver_confirmed_sources, ["quad"])

    def test_same_time_or_expired_hypotheses_cannot_confirm(self):
        mission = TowerMission(any_sensor=True)
        first = hit("quad", 0)
        mission.update([first, first, hit("plane", 0), hit("tower-1", 0)], 0)
        self.assertIsNone(mission.acquired_at)
        self.assertEqual(mission.accepted, [])
        self.assertEqual(mission.rejected, 1)
        mission.update([hit("quad", 20, (5., 0.))], 20)
        self.assertIsNone(mission.acquired_at)
        mission.update([hit("quad", 25, (10., 0.))], 25)
        self.assertEqual(mission.acquired_at, 25)

    def test_same_camera_clutter_preserves_an_unconfirmed_alternative(self):
        mission = TowerMission(any_sensor=True)
        mission.update([hit("quad", 0, (1000., 1000.), .95), hit("quad", 0)], 0)
        self.assertIsNone(mission.acquired_at)
        mission.update([hit("quad", 5, (5., 0.))], 5)
        self.assertEqual(mission.acquired_at, 5)
        self.assertEqual(mission.receiver_confirmed_sources, ["quad"])

    def test_pending_hypotheses_are_bounded_and_expire(self):
        mission = TowerMission(any_sensor=True)
        mission.update([hit(f"sensor-{index}", 0, (index*1000., 0.)) for index in range(100)], 0)
        self.assertIsNone(mission.acquired_at)
        self.assertLessEqual(len(mission._pending_candidates), 32)
        mission.update([], 30)
        self.assertEqual(mission._pending_candidates, [])

    def test_delayed_fresh_frame_uses_observation_time_for_confirmation(self):
        mission = TowerMission(any_sensor=True)
        mission.update([hit("quad", 0)], 0)
        mission.update([hit("quad", 10, (5., 0.))], 20)
        self.assertEqual(mission.acquired_at, 20)
        self.assertEqual(mission.last_observed, 10)

    def test_unaccepted_frame_cannot_be_reused_on_a_later_update(self):
        mission = TowerMission(any_sensor=True)
        mission.update([hit("quad", 0)], 0)
        mission.update([hit("quad", 0, (1., 0.)), hit("quad", -20), hit("plane", 20)], 5)
        self.assertEqual(mission.rejected, 3)
        self.assertIsNone(mission.acquired_at)
        mission.update([hit("quad", 5)], 5)
        self.assertEqual(mission.acquired_at, 5)

    def test_legacy_association_behavior_is_preserved(self):
        mission = TowerMission()
        mission.update([hit("tower-1", 0), hit("tower-2", 0, (1000., 1000.))], 0)
        mission.update([hit("tower-1", 5), hit("tower-2", 5, (-1000., 1000.))], 5)
        self.assertIsNone(mission.acquired_at)
        mission = TowerMission()
        mission.update([hit("tower-1", 0)], 0)
        mission.update([hit("tower-1", 5)], 5)
        mission.update([hit("tower-1", 10, (1000., 1000.), .95), hit("tower-1", 10)], 10)
        self.assertEqual(mission.accepted, [])
        self.assertEqual(mission.last_observed, 5)


if __name__ == "__main__":
    unittest.main()
