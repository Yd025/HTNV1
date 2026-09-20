"""Train/evaluate an optional local maritime detector on labeled local data.

Examples (backend cwd):
  python -m vision.train_vessel check --data /data/maritime.yaml
  python -m vision.train_vessel train --data /data/maritime.yaml --weights /models/trusted.pt
  python -m vision.train_vessel evaluate --data /data/maritime.yaml --weights /models/best.pt --split test

Uses the official Ultralytics train/val API. No data or weights are downloaded.
Split complete voyages/videos before export; duplicate content checks cannot
detect leakage between adjacent but different frames of one recording.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any

from vision.vessel import load_local_model

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


def _local_path(value: str, root: Path) -> Path:
    if "://" in value or value.startswith(("\\\\", "//")):
        raise ValueError("Only local dataset paths are supported")
    path = Path(value).expanduser()
    return (path if path.is_absolute() else root / path).resolve()


def _images(value: Any, root: Path) -> set[Path]:
    values = value if isinstance(value, list) else [value]
    found: set[Path] = set()
    for entry in values:
        if not isinstance(entry, str):
            raise ValueError("Dataset split entries must be local path strings")
        path = _local_path(entry, root)
        if path.is_dir():
            found.update(p.resolve() for p in path.rglob("*") if p.suffix.lower() in IMAGE_SUFFIXES)
        elif path.is_file() and path.suffix.lower() == ".txt":
            for line in path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    candidate = _local_path(line.strip(), path.parent)
                    if not candidate.is_file() or candidate.suffix.lower() not in IMAGE_SUFFIXES:
                        raise ValueError(f"Missing/local image required: {candidate}")
                    found.add(candidate)
        else:
            raise ValueError(f"Dataset split must be an existing image directory or local .txt list: {path}")
    if not found:
        raise ValueError("Dataset split contains no images")
    return found


def check_dataset(data: Path, require_test: bool = False) -> dict[str, Any]:
    """Validate data paths, YOLO boxes, distinct files/content across splits."""
    data = data.expanduser().resolve()
    if not data.is_file():
        raise ValueError(f"Dataset YAML does not exist: {data}")
    content = data.read_text(encoding="utf-8")
    try:
        config = json.loads(content)  # JSON is also valid YAML; permits stdlib checks.
    except json.JSONDecodeError:
        try:
            import yaml
        except ImportError as exc:
            raise RuntimeError("Install requirements-vision.txt for YAML, or supply equivalent JSON") from exc
        config = yaml.safe_load(content)
    if not isinstance(config, dict) or "download" in config:
        raise ValueError("Use a local dataset YAML without a download/script field")
    names = config.get("names")
    if not isinstance(names, (dict, list)) or not names:
        raise ValueError("Dataset must define class names")
    normalized = {int(k): str(v).lower().strip() for k, v in names.items()} if isinstance(names, dict) else dict(enumerate(str(v).lower().strip() for v in names))
    if set(normalized) != set(range(len(normalized))):
        raise ValueError("Dataset class indices must be contiguous from zero")
    if not {"boat", "ship", "vessel"} & set(normalized.values()):
        raise ValueError("Dataset must include a named boat, ship, or vessel class")
    root = _local_path(str(config.get("path", ".")), data.parent)
    required = ["train", "val"] + (["test"] if require_test else [])
    splits = {split: _images(config.get(split), root) for split in required}
    if "test" in config and "test" not in splits:
        splits["test"] = _images(config["test"], root)
    owner_by_hash: dict[str, str] = {}
    labels = 0
    for split, images in splits.items():
        for image in sorted(images):
            digest = hashlib.sha256(image.read_bytes()).hexdigest()
            if digest in owner_by_hash and owner_by_hash[digest] != split:
                raise ValueError(f"Train/evaluation leakage: duplicate image content in {owner_by_hash[digest]} and {split}")
            owner_by_hash[digest] = split
            parts = list(image.parts)
            positions = [i for i, part in enumerate(parts) if part == "images"]
            if not positions:
                raise ValueError(f"YOLO image path needs an images directory: {image}")
            parts[positions[-1]] = "labels"
            label = Path(*parts).with_suffix(".txt")
            if not label.is_file():
                raise ValueError(f"Missing label (use an empty file for a negative image): {label}")
            for row in label.read_text(encoding="utf-8").splitlines():
                if not row.strip():
                    continue
                values = row.split()
                if len(values) != 5:
                    raise ValueError(f"Expected YOLO class/cx/cy/width/height: {label}")
                class_id = int(values[0])
                cx, cy, w, h = (float(x) for x in values[1:])
                if class_id not in normalized or not all(math.isfinite(v) for v in (cx, cy, w, h)):
                    raise ValueError(f"Invalid class or nonfinite box: {label}")
                if not (0 <= cx <= 1 and 0 <= cy <= 1 and 0 < w <= 1 and 0 < h <= 1):
                    raise ValueError(f"Box must be normalized to the image: {label}")
                labels += 1
    # Pass only sanitized absolute paths to Ultralytics; never execute YAML
    # download hooks or resolve a dataset alias against the network.
    return {"dataset": str(data), "root": str(root), "names": normalized,
            "splits": {k: sorted(str(p) for p in v) for k, v in splits.items()},
            "counts": {k: len(v) for k, v in splits.items()}, "label_count": labels,
            "split_requirement": "Hold out complete recordings/voyages; adjacent-frame leakage is not detectable here"}


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("action", choices=["check", "train", "evaluate"])
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--weights", help="Trusted local model; no automatic pretrained downloads")
    parser.add_argument("--output", type=Path, default=Path("runs/vessel"))
    parser.add_argument("--epochs", type=int, default=50)
    parser.add_argument("--imgsz", type=int, default=960)
    parser.add_argument("--batch", type=int, default=4)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--split", choices=["val", "test"], default="test")
    args = parser.parse_args(argv)
    report = check_dataset(args.data, require_test=args.action == "evaluate" and args.split == "test")
    if args.action == "check":
        print(json.dumps({k: v for k, v in report.items() if k != "splits"}, indent=2))
        return
    if not args.weights:
        parser.error("--weights must name a trusted local model file")
    if args.epochs < 1 or args.imgsz < 32 or args.batch < 1:
        parser.error("epochs/batch must be positive and imgsz >= 32")
    model = load_local_model(args.weights)
    import yaml
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    dataset = {"path": report["root"], "names": report["names"]}
    for split, images in report["splits"].items():
        listing = output / f"{split}-images.txt"
        listing.write_text("\n".join(images) + "\n", encoding="utf-8")
        dataset[split] = str(listing)
    sanitized = output / "dataset.local.yaml"
    sanitized.write_text(yaml.safe_dump(dataset), encoding="utf-8")
    common = {"data": str(sanitized), "imgsz": args.imgsz, "batch": args.batch,
              "device": args.device, "workers": 0, "plots": False,
              "project": str(output), "name": args.action}
    if args.action == "train":
        result = model.train(**common, epochs=args.epochs, seed=args.seed, deterministic=True)
    else:
        result = model.val(**common, split=args.split)
    metrics = {str(k): float(v) for k, v in getattr(result, "results_dict", {}).items() if isinstance(v, (float, int))}
    summary = {k: v for k, v in report.items() if k != "splits"}
    summary.update({"action": args.action, "weights": str(Path(args.weights).resolve()),
                    "weights_sha256": hashlib.sha256(Path(args.weights).read_bytes()).hexdigest(),
                    "seed": args.seed, "evaluation_split": "val" if args.action == "train" else args.split,
                    "metrics": metrics, "deployment_validated": False})
    path = output / f"{args.action}-summary.json"
    path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
