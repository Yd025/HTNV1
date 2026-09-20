import io
import json
import math
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from PIL import Image, ImageDraw

from geo import ll_to_ne
from mavlink_connection import MavlinkBridge
from sim.cameras import CameraSpec, MjpegTap, spec_for
from sim.detector import PixelHit, _ground_hit, detect_image, project_hit
from sim.types import Detection, VehicleState
from sim.whiteout import WhiteoutAdapter
from vision.train_vessel import check_dataset
from vision.vessel import CameraDetector, DetectorConfig, DetectorUnavailable, load_local_model


def jpeg(image):
    stream = io.BytesIO()
    image.save(stream, format="JPEG")
    return stream.getvalue()


class Array:
    def __init__(self, value):
        self.value = value
    def tolist(self):
        return self.value


def results():
    return [SimpleNamespace(names={0: "person", 7: "boat", 13: "ship"}, boxes=SimpleNamespace(
        xyxy=Array([[20, 40, 80, 90], [50, 50, 60, 60], [90, 40, 130, 80], [20, 40, 80, 199]]),
        conf=Array([.9, .99, .8, .95]), cls=Array([7, 0, 13, 7])))]


class VisionTests(unittest.TestCase):
    def test_baseline_sees_synthetic_red_hull_and_not_empty_water(self):
        image = Image.new("RGB", (280, 180), (15, 25, 40))
        self.assertIsNone(detect_image(image))
        ImageDraw.Draw(image).rectangle((130, 100, 144, 106), fill=(160, 30, 25))
        hit = detect_image(image)
        self.assertIsNotNone(hit)
        self.assertGreaterEqual(hit.v, 106)
        self.assertIsNotNone(hit.bbox)
        self.assertEqual(hit.detector, "simulator_blob")

    def test_model_class_names_waterline_and_multiple_vessels(self):
        model = Mock()
        model.predict.return_value = results()
        detector = CameraDetector(DetectorConfig(backend="yolo"), model=model)
        hits = detector.detect_jpeg(jpeg(Image.new("RGB", (280, 200))))
        self.assertEqual(len(hits), 2)
        self.assertEqual((hits[0].u, hits[0].v), (50., 90.))
        self.assertEqual(hits[0].detector, "yolo")
        self.assertEqual(detector.status()["state"], "ready")

    def test_configured_model_failure_is_explicit_no_blob_fallback(self):
        model = Mock()
        model.predict.side_effect = RuntimeError("bad model")
        detector = CameraDetector(DetectorConfig(backend="yolo"), model=model)
        with self.assertRaises(DetectorUnavailable):
            detector.detect_jpeg(jpeg(Image.new("RGB", (280, 200))))
        self.assertEqual(detector.status()["state"], "unavailable")
        with self.assertRaises(DetectorUnavailable):
            load_local_model("missing-local-model.pt")

    def test_missing_vessel_class_is_explicit(self):
        model = Mock()
        output = results()
        output[0].names = {0: "person", 7: "car", 13: "bus"}
        model.predict.return_value = output
        detector = CameraDetector(DetectorConfig(backend="yolo"), model=model)
        with self.assertRaisesRegex(DetectorUnavailable, "class names"):
            detector.detect_jpeg(jpeg(Image.new("RGB", (280, 200))))

    def test_projection_uses_water_height_and_true_rotated_bearing(self):
        hit = PixelHit(320, 240, 640, 480, .8, "vessel")
        spec = CameraSpec("cam", 1, math.pi / 2, 0, "test")
        pose = VehicleState("cam", 1, "copter", 72, -94, 100, 90)
        det = project_hit(hit, spec, pose, 123., pitch_rad=-math.pi / 4)
        n, e = ll_to_ne(det.lat, det.lon, pose.lat, pose.lon)
        self.assertAlmostEqual(n, 0., places=4)
        self.assertAlmostEqual(e, 100., places=4)
        self.assertAlmostEqual(det.bearing, 90.)
        self.assertAlmostEqual(det.range_m, math.sqrt(20000))
        self.assertIsNone(_ground_hit(320, 200, 640, 480, math.pi / 2, 0, 0, 0, 100))
        self.assertIsNone(_ground_hit(320, 200, 0, 480, math.pi / 2, 0, 0, 0, 100))

    def test_mavlink_keeps_msl_and_home_relative_altitudes_distinct(self):
        bridge = MavlinkBridge()
        bridge._ingest_message("GLOBAL_POSITION_INT", SimpleNamespace(
            lat=720000000, lon=-940000000, alt=159500, relative_alt=40000, hdg=9000))
        state = bridge.snapshot()
        self.assertEqual(state["alt"], 40.)
        self.assertEqual(state["alt_msl"], 159.5)

    def test_fixed_quad_center_ray_intersects_water_twenty_degrees_down(self):
        spec = spec_for("quadcopter")
        self.assertEqual(spec.pitch_bias_deg, -20.)
        hit = PixelHit(480, 360, 960, 720, .9, "vessel")
        pose = VehicleState("quadcopter", 1, "copter", 72., -94., alt=100., heading=0.)
        det = project_hit(hit, spec, pose, 100.)
        self.assertIsNotNone(det)
        north, east = ll_to_ne(det.lat, det.lon, pose.lat, pose.lon)
        self.assertAlmostEqual(north, 100. / math.tan(math.radians(20.)), places=4)
        self.assertAlmostEqual(east, 0., places=4)

    def test_camera_mount_rotates_with_measured_aircraft_bank(self):
        spec = spec_for("quadcopter")
        hit = PixelHit(480, 360, 960, 720, .9, "vessel")
        pose = VehicleState("quadcopter", 1, "copter", 72., -94., alt=100., heading=0.)
        det = project_hit(hit, spec, pose, 100., roll_rad=math.radians(30.))
        north, east = ll_to_ne(det.lat, det.lon, pose.lat, pose.lon)
        # Camera ray in body axes is (cos20, 0, sin20); banking the complete
        # fixed mount produces an east component -sin20*sin30.
        self.assertAlmostEqual(north, 100. / (math.tan(math.radians(20.))*math.cos(math.radians(30.))), places=4)
        self.assertAlmostEqual(east, -100. * math.tan(math.radians(30.)), places=4)
        self.assertLess(det.bearing, 360.)
        self.assertGreater(det.bearing, 340.)

    def test_dataset_rejects_copied_train_image_in_validation(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for split in ["train", "val"]:
                (root / split / "images").mkdir(parents=True)
                (root / split / "labels").mkdir()
                Image.new("RGB", (20, 20)).save(root / split / "images" / "a.jpg")
                (root / split / "labels" / "a.txt").write_text("0 .5 .5 .4 .2\n")
            data = root / "data.yaml"
            data.write_text(json.dumps({"train": "train/images", "val": "val/images", "names": ["boat"]}))
            with self.assertRaisesRegex(ValueError, "leakage"):
                check_dataset(data)
            Image.new("RGB", (20, 20), "red").save(root / "val" / "images" / "a.jpg")
            report = check_dataset(data)
            self.assertEqual(report["counts"], {"train": 1, "val": 1})
            with self.assertRaises(ValueError):
                check_dataset(data, require_test=True)


class CameraFreshnessTests(unittest.IsolatedAsyncioTestCase):
    async def test_empty_scan_preserves_unconsumed_fresh_observations(self):
        adapter = WhiteoutAdapter()
        det = Detection("tower-1", 72., -94., "vessel", .9, 99.)
        adapter._dets = [det]
        with patch("sim.whiteout.time.time", return_value=100.), patch("sim.whiteout.grab_jpeg", new=AsyncMock(return_value=None)):
            await adapter._scan_cameras(Mock())
            self.assertEqual(await adapter.poll_detections(), [det])
            self.assertEqual(await adapter.poll_detections(), [])
        await adapter.close()

    async def test_stream_frame_is_inferred_once_even_after_consumption(self):
        adapter = WhiteoutAdapter()
        adapter._poses["tower-1"] = VehicleState("tower-1", 1, "tower", 72., -94., 119.5)
        adapter._last_ok["tower-1"] = True
        adapter._look["tower-1"] = (0., -8.)
        frame = jpeg(Image.new("RGB", (640, 480)))
        adapter._taps._receive("tower-1", frame)
        hit = PixelHit(320, 300, 640, 480, .9, "vessel")
        with patch.object(adapter._detector, "detect_jpeg", return_value=[hit]) as infer, patch("sim.whiteout.grab_jpeg", new=AsyncMock(return_value=None)):
            await adapter._scan_cameras(Mock())
            first = await adapter.poll_detections()
            self.assertEqual(len(first), 1)
            self.assertIsNotNone(first[0].frame_id)
            await adapter._scan_cameras(Mock())
            self.assertEqual(await adapter.poll_detections(), [])
            infer.assert_called_once()
        await adapter.close()

    async def test_local_height_not_mistaken_for_sea_height(self):
        adapter = WhiteoutAdapter()
        adapter._poses["quadcopter"] = VehicleState("quadcopter", 1, "copter", 72., -94., 40)
        adapter._last_ok["quadcopter"] = True
        adapter._taps._receive("quadcopter", jpeg(Image.new("RGB", (640, 480))))
        with patch.object(adapter._detector, "detect_jpeg") as infer, patch("sim.whiteout.grab_jpeg", new=AsyncMock(return_value=None)):
            await adapter._scan_cameras(Mock())
            infer.assert_not_called()
        self.assertEqual(adapter._camera_status["quadcopter"]["state"], "sea_height_unavailable")
        await adapter.close()


if __name__ == "__main__":
    unittest.main()
