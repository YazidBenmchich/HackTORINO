"""Train the HelioScan YOLO defect detector and export it for the Arduino UNO Q.

Transfer learning: start from YOLO11n weights pre-trained on COCO (generic visual features)
and fine-tune all layers on the synthetic C14 dataset (generate_dataset.py). Training is
bounded by wall-clock time (default 15 min on a laptop CPU); Ultralytics adapts the
learning-rate schedule to that budget.

Outputs
-------
- app/python/models/helioscan_yolo11n.onnx   model deployed on the board (ONNX Runtime)
- app/python/models/model_card.json          classes, input size, validation metrics
- training/runs/...                          curves, confusion matrix, sample predictions

Usage
-----
    python training/train.py --minutes 15
"""

from __future__ import annotations

import argparse
import json
import shutil
import time
from pathlib import Path

from ultralytics import YOLO

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, default=ROOT / "training" / "dataset" / "data.yaml")
    ap.add_argument("--weights", default="yolo11n.pt", help="pre-trained starting point")
    ap.add_argument("--minutes", type=float, default=15.0, help="training time budget")
    ap.add_argument("--imgsz", type=int, default=320, help="network input size (also used on the board)")
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--models", type=Path, default=ROOT / "app" / "python" / "models")
    args = ap.parse_args()

    model = YOLO(args.weights)
    t0 = time.time()
    model.train(
        data=str(args.data),
        imgsz=args.imgsz,
        epochs=200,                     # upper bound: the time budget stops training first
        time=args.minutes / 60.0,
        batch=args.batch,
        device="cpu",
        workers=2,
        project=str(ROOT / "training" / "runs"),
        name="c14",
        exist_ok=True,
        seed=14,
        patience=200,
        # augmentation on top of the synthetic views
        hsv_h=0.01, hsv_s=0.4, hsv_v=0.4,
        degrees=5.0, translate=0.1, scale=0.4, fliplr=0.5, flipud=0.2,
        mosaic=1.0, close_mosaic=3,
        plots=True,
        verbose=False,
    )
    train_minutes = (time.time() - t0) / 60.0

    best = ROOT / "training" / "runs" / "c14" / "weights" / "best.pt"
    model = YOLO(str(best))
    metrics = model.val(data=str(args.data), imgsz=args.imgsz, device="cpu", split="val", plots=True, verbose=False)
    names = model.names
    per_class = {names[int(c)]: round(float(ap50), 4) for c, ap50 in zip(metrics.box.ap_class_index, metrics.box.ap50)}
    summary = {
        "precision": round(float(metrics.box.mp), 4),
        "recall": round(float(metrics.box.mr), 4),
        "mAP50": round(float(metrics.box.map50), 4),
        "mAP50_95": round(float(metrics.box.map), 4),
        "AP50_per_class": per_class,
    }

    onnx_path = Path(model.export(format="onnx", imgsz=args.imgsz, opset=12, dynamic=False, simplify=True))
    args.models.mkdir(parents=True, exist_ok=True)
    target = args.models / "helioscan_yolo11n.onnx"
    shutil.copy2(onnx_path, target)

    stats_file = args.data.parent / "stats.json"
    card = {
        "model": "YOLO11n (Ultralytics), fine-tuned",
        "task": "object detection",
        "classes": [names[i] for i in sorted(names)],
        "input": {"size": args.imgsz, "format": "RGB float32 NCHW, 0..1, letterboxed"},
        "output": "1 x (4 + num_classes) x anchors, boxes as cx, cy, w, h in input pixels",
        "pretrained_from": args.weights,
        "training_minutes": round(train_minutes, 1),
        "dataset": json.loads(stats_file.read_text()) if stats_file.exists() else None,
        "validation": summary,
    }
    (args.models / "model_card.json").write_text(json.dumps(card, indent=2))
    print(json.dumps(card, indent=2))
    print(f"ONNX model -> {target}")


if __name__ == "__main__":
    main()
