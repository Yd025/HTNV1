"""Local vessel object detection behind an explicit, optional model backend.

API reference: https://docs.ultralytics.com/modes/predict/
No weights are bundled/downloaded. Supply a trusted local detection model with
boat/ship/vessel class names; classification-only models are not sufficient.
"""
from __future__ import annotations

import io
import math
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PIL import Image, ImageStat

from sim.detector import PixelHit, detect_image


class DetectorUnavailable(RuntimeError):
    pass


@dataclass(frozen=True)
class DetectorConfig:
    backend: str = "blob"
    weights: str = ""
    confidence: float = .4
    image_size: int = 960
    device: str = "cpu"
    classes: tuple[str, ...] = ("boat", "ship", "vessel")

    @classmethod
    def from_env(cls) -> DetectorConfig:
        return cls(
            backend=os.getenv("VESSEL_DETECTOR", "blob").lower().strip(),
            weights=os.getenv("VESSEL_MODEL_PATH", "").strip(),
            confidence=float(os.getenv("VESSEL_CONFIDENCE", ".4")),
            image_size=int(os.getenv("VESSEL_IMAGE_SIZE", "960")),
            device=os.getenv("VESSEL_DEVICE", "cpu"),
            classes=tuple(x.strip().lower() for x in os.getenv("VESSEL_CLASSES", "boat,ship,vessel").split(",") if x.strip()),
        )


def load_local_model(weights: str) -> Any:
    path = Path(weights).expanduser()
    if not weights or not path.is_file() or path.suffix.lower() not in {".pt", ".onnx"}:
        raise DetectorUnavailable("Set VESSEL_MODEL_PATH to a trusted existing local .pt or .onnx vessel detection model")
    # Disable optional package installation/network checks in the model runtime.
    os.environ["YOLO_OFFLINE"] = "true"
    os.environ["YOLO_AUTOINSTALL"] = "false"
    try:
        from ultralytics import YOLO
    except ImportError as exc:
        raise DetectorUnavailable("YOLO requires optional backend/requirements-vision.txt dependencies") from exc
    try:
        return YOLO(str(path.resolve()), task="detect")
    except Exception as exc:
        raise DetectorUnavailable(f"Cannot load vessel model: {type(exc).__name__}: {exc}") from exc


class CameraDetector:
    """A shared serial inference worker; no neural work runs in brain.tick()."""

    def __init__(self, config: DetectorConfig | None = None, model: Any = None) -> None:
        self.config = config or DetectorConfig.from_env()
        if self.config.backend not in {"blob", "yolo"}:
            raise ValueError("VESSEL_DETECTOR must be blob (simulator baseline) or yolo")
        if not 0 < self.config.confidence <= 1 or self.config.image_size < 32 or not self.config.classes:
            raise ValueError("Invalid vessel confidence, image size, or class names")
        self._model = model
        self.state = "baseline" if self.config.backend == "blob" else "configured"
        self.error: str | None = None
        self.last_frame: dict[str, Any] = {}

    def status(self) -> dict[str, Any]:
        return {"backend": self.config.backend, "state": self.state, "error": self.error,
                "model": Path(self.config.weights).name if self.config.weights else None,
                "classes": list(self.config.classes), "confidence_threshold": self.config.confidence,
                "last_frame": dict(self.last_frame),
                "validation": "unvalidated local weights" if self.config.backend == "yolo" else "simulator color baseline only"}

    def initialize(self) -> None:
        if self.config.backend != "yolo" or self._model is not None:
            return
        try:
            self._model = load_local_model(self.config.weights)
            self.state = "ready"
            self.error = None
        except DetectorUnavailable as exc:
            self.state = "unavailable"
            self.error = str(exc)
            raise

    def detect_jpeg(self, jpeg: bytes) -> list[PixelHit]:
        started = time.perf_counter()
        try:
            with Image.open(io.BytesIO(jpeg)) as source:
                image = source.convert("RGB")
        except (OSError, ValueError):
            self.last_frame = {"quality": "invalid_jpeg", "detections": 0}
            return []
        if min(image.size) < 8:
            self.last_frame = {"quality": "too_small", "detections": 0}
            return []
        stats = ImageStat.Stat(image.resize((64, 64)).convert("L"))
        quality = "low_contrast" if stats.stddev[0] < 3.0 else "usable"
        try:
            if self.config.backend == "blob":
                hit = detect_image(image)
                hits = [hit] if hit is not None else []
            else:
                self.initialize()
                predictions = self._model.predict(source=image, conf=self.config.confidence,
                    imgsz=self.config.image_size, device=self.config.device, verbose=False,
                    max_det=30, save=False)
                hits = self._extract(predictions, image.width, image.height)
                self.state = "ready"
            self.error = None
        except Exception as exc:
            self.state = "unavailable"
            self.error = str(exc)
            self.last_frame = {"quality": quality, "detections": 0, "error": self.error}
            raise DetectorUnavailable(f"Vessel inference unavailable: {exc}") from exc
        self.last_frame = {"quality": quality, "detections": len(hits),
                           "width": image.width, "height": image.height,
                           "inference_ms": round((time.perf_counter() - started) * 1000, 2)}
        return hits

    def _extract(self, predictions: Any, width: int, height: int) -> list[PixelHit]:
        hits = []
        known_vessel_class = False
        for result in predictions:
            names = result.names
            class_values = names.values() if isinstance(names, dict) else names
            known_vessel_class |= any(str(name).strip().lower() in self.config.classes for name in class_values)
            boxes = result.boxes
            if boxes is None:
                raise DetectorUnavailable("Model has no detection boxes; use an object detection model")
            for xyxy, score, class_id in zip(boxes.xyxy.tolist(), boxes.conf.tolist(), boxes.cls.tolist(), strict=True):
                name = str(names[int(class_id)]).strip().lower()
                if name not in self.config.classes or score < self.config.confidence:
                    continue
                if not all(math.isfinite(float(x)) for x in [*xyxy, score]):
                    continue
                x1, y1, x2, y2 = (float(x) for x in xyxy)
                x1, x2 = max(0.0, x1), min(float(width - 1), x2)
                y1 = max(0.0, y1)
                # A truncated lower hull has no usable waterline; do not invent
                # its ground position from a box touching the image boundary.
                if x2 - x1 < 3 or y2 - y1 < 3 or y2 >= height - 1 or y2 <= 0:
                    continue
                hits.append(PixelHit((x1 + x2) / 2, y2, float(width), float(height),
                                     float(score), "vessel", (x1, y1, x2, y2), "yolo"))
        if not known_vessel_class:
            raise DetectorUnavailable("Model class names do not contain configured vessel classes")
        return sorted(hits, key=lambda hit: hit.confidence, reverse=True)
