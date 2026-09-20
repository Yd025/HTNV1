import unittest

from judge_tracks import JudgeTrackPublisher
from tracker import Track


class JudgeTrackTests(unittest.TestCase):
    def test_offer_is_silent_until_a_confirmed_track_exists(self):
        pub = JudgeTrackPublisher(enabled=True, url="http://127.0.0.1:8010/api/tracks", name="Sierra One")
        self.assertIsNone(pub.offer(False, Track(71.99, -94.82), now=1.0))
        self.assertIsNone(pub.offer(True, None, now=1.0))
        payload = pub.offer(True, Track(71.9965, -94.8448, vn=1.0, ve=-1.0), now=1.0)
        self.assertEqual(payload["name"], "Sierra One")
        self.assertEqual(payload["lat"], 71.9965)
        self.assertGreater(payload["speed"], 1.0)
        self.assertIsNone(pub.offer(True, Track(71.9966, -94.8449), now=1.2))
