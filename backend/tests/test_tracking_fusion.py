"""Target-only regression evidence; no image-model accuracy claims."""
import unittest

from geo import ll_to_ne, ne_to_ll
from sim.types import Detection
from tracker import TargetTracker


def detection(t, n, e=0., source="tower", frame=None, confidence=.9):
    return Detection(source, *ne_to_ll(n, e), "vessel", confidence, 1000. + t,
                     frame_id=frame or f"{source}:{t}", observation_id=frame or f"{source}:{t}")


class FusionTests(unittest.TestCase):
    def test_irregular_observation_intervals_estimate_true_velocity(self):
        tracker = TargetTracker()
        for t in [0., 1., 2., 5., 6., 10., 15., 19.]:
            track = tracker.update([detection(t, 5 * t)], now=t, observation_now=1000+t)
        self.assertAlmostEqual(track.vn, 5., delta=.4)
        self.assertAlmostEqual(ll_to_ne(track.lat, track.lon)[0], 95., delta=2.)
        self.assertEqual(track.status, "observed")

    def test_gaps_predict_full_elapsed_time_and_expire(self):
        tracker = TargetTracker()
        for t in range(12):
            track = tracker.update([detection(t, 5*t)], now=float(t))
        old_n = ll_to_ne(track.lat, track.lon)[0]
        old_sigma, velocity = track.sigma_m, track.vn
        track = tracker.update([], now=18.)
        self.assertAlmostEqual(ll_to_ne(track.lat, track.lon)[0], old_n + velocity * 7, places=4)
        self.assertEqual(track.age_s, 7.)
        self.assertEqual(track.status, "coasting")
        self.assertGreater(track.sigma_m, old_sigma)
        self.assertIsNone(tracker.update([], now=40.))

    def test_duplicates_and_out_of_order_do_not_confirm_or_reset_age(self):
        tracker = TargetTracker()
        det = detection(0, 0)
        tracker.update([det], now=0., observation_now=1000.)
        track = tracker.update([det], now=2., observation_now=1002.)
        self.assertEqual(track.hits, 1)
        self.assertEqual(track.age_s, 2.)
        tracker.update([detection(3, 15)], now=3., observation_now=1003.)
        track = tracker.update([detection(2, 10)], now=4., observation_now=1004.)
        self.assertEqual(track.hits, 2)
        self.assertEqual(tracker.accepted_detections, [])
        self.assertEqual(tracker.rejected_detections[0]["reason"], "out_of_order")

    def test_delayed_observation_retains_measurement_age(self):
        tracker = TargetTracker()
        track = tracker.update([detection(0, 0)], now=10., observation_now=1002.)
        self.assertEqual(track.age_s, 2.)
        self.assertEqual(track.status, "coasting")

    def test_sensor_handoff_accepts_copter_and_rejects_outlier(self):
        tracker = TargetTracker()
        tracker.update([detection(0, 0)], now=0.)
        observations = [detection(1, 5, source="tower"), detection(1, 6, source="copter"),
                        detection(1, 2000, source="clutter")]
        track = tracker.update(observations, now=1.)
        self.assertEqual({d.source_id for d in tracker.accepted_detections}, {"tower", "copter"})
        self.assertEqual(track.hits, 3)
        self.assertIn("copter", track.observed_sources)

    def test_same_frame_boxes_cannot_count_as_two_hits(self):
        tracker = TargetTracker()
        first, second = detection(0, 0, frame="frame"), detection(0, 1, frame="frame")
        first.observation_id, second.observation_id = "box0", "box1"
        tracker.update([first, second], now=0.)
        self.assertEqual(tracker.track.hits, 1)
        self.assertEqual(len(tracker.accepted_detections), 1)

    def test_delayed_receiver_after_newer_tower_can_confirm_handoff(self):
        tracker = TargetTracker()
        tracker.update([detection(0, 0)], now=0., observation_now=1000.)
        tracker.update([detection(3, 15)], now=3., observation_now=1003.)
        aircraft = detection(2, 10, source="copter")
        track = tracker.update([aircraft], now=4., observation_now=1004.)
        self.assertEqual(tracker.accepted_detections, [aircraft])
        self.assertEqual(track.last_observation_timestamp, 1003.)
        self.assertEqual(track.age_s, 1.)

    def test_clock_cannot_run_backwards(self):
        tracker = TargetTracker()
        tracker.update([], now=0.)
        with self.assertRaisesRegex(ValueError, "nondecreasing"):
            tracker.update([], now=-1.)


if __name__ == "__main__":
    unittest.main()
