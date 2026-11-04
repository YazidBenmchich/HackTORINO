"""Detector accuracy of an ONNX model, measured with the board's own code.

Runs helioscan.detector.YoloDetector (the exact letterbox, ONNX Runtime session, decoding and
NMS used on the UNO Q) over a split of the YOLO dataset and computes the usual detection
metrics. This is what compares two models on equal terms: no training framework is involved.

Metrics
    AP50, AP50-95   area under the precision-recall curve (COCO 101-point interpolation),
                    at IoU 0.5 and averaged over IoU 0.5 : 0.95
    P, R            precision and recall at the board's operating threshold (conf 0.35)

Usage
-----
    python tools/evaluate_detector.py                                  # deployed model, test split
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app" / "python"))

from helioscan.detector import YoloDetector  # noqa: E402

IOUS = np.linspace(0.5, 0.95, 10)


def load_labels(path: Path, w: int, h: int) -> np.ndarray:
    """YOLO label file → (n, 5) array of class, x0, y0, x1, y1 in pixels."""
    if not path.exists() or not path.read_text().strip():
        return np.zeros((0, 5))
    a = np.loadtxt(path, ndmin=2)
    c, cx, cy, bw, bh = a.T
    return np.stack([c, (cx - bw / 2) * w, (cy - bh / 2) * h, (cx + bw / 2) * w, (cy + bh / 2) * h], axis=1)


def iou_matrix(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    ix = np.clip(np.minimum(a[:, None, 2], b[None, :, 2]) - np.maximum(a[:, None, 0], b[None, :, 0]), 0, None)
    iy = np.clip(np.minimum(a[:, None, 3], b[None, :, 3]) - np.maximum(a[:, None, 1], b[None, :, 1]), 0, None)
    inter = ix * iy
    area = lambda r: (r[:, 2] - r[:, 0]) * (r[:, 3] - r[:, 1])
    return inter / (area(a)[:, None] + area(b)[None, :] - inter + 1e-9)


def average_precision(tp: np.ndarray, conf: np.ndarray, n_gt: int) -> float:
    if n_gt == 0:
        return float("nan")
    if len(tp) == 0:
        return 0.0
    order = np.argsort(-conf)
    tp = tp[order]
    ctp, cfp = np.cumsum(tp), np.cumsum(1 - tp)
    recall = ctp / n_gt
    precision = ctp / (ctp + cfp)
    precision = np.maximum.accumulate(precision[::-1])[::-1]  # monotone envelope
    grid = np.linspace(0, 1, 101)
    idx = np.searchsorted(recall, grid, side="left")
    return float(np.mean([precision[i] if i < len(precision) else 0.0 for i in idx]))


def evaluate(model: Path, split_dir: Path, labels_dir: Path, classes: list[str], imgsz: int,
             operating_conf: float = 0.35, threads: int = 4) -> dict:
    det = YoloDetector(model, classes, imgsz=imgsz, conf=operating_conf, floor=0.001, threads=threads)
    images = sorted(split_dir.glob("*.jpg"))
    nc = len(classes)
    records = {c: {"tp": [], "conf": [], "n_gt": 0} for c in range(nc)}
    op = {"tp": 0, "fp": 0, "n_gt": 0}
    times = []
    for p in images:
        img = cv2.imread(str(p))
        h, w = img.shape[:2]
        gt = load_labels(labels_dir / f"{p.stem}.txt", w, h)
        t = time.perf_counter()
        dets = det.detect(img)
        times.append(time.perf_counter() - t)
        boxes = np.array([d.box for d in dets]).reshape(-1, 4)
        cls = np.array([d.cls for d in dets], int)
        conf = np.array([d.conf for d in dets])
        op["n_gt"] += len(gt)
        for c in range(nc):
            g = gt[gt[:, 0] == c, 1:]
            sel = cls == c
            b, s = boxes[sel], conf[sel]
            records[c]["n_gt"] += len(g)
            tp = np.zeros((len(b), len(IOUS)))
            if len(b) and len(g):
                ious = iou_matrix(b, g)
                for k, thr in enumerate(IOUS):
                    used = set()
                    for i in np.argsort(-s):  # greedy by confidence, one match per ground-truth box
                        j = int(np.argmax(np.where([jj not in used for jj in range(len(g))], ious[i], -1)))
                        if ious[i, j] >= thr and j not in used:
                            used.add(j)
                            tp[i, k] = 1
            records[c]["tp"].append(tp)
            records[c]["conf"].append(s)
            keep = s >= operating_conf
            op["tp"] += int(tp[keep, 0].sum())
            op["fp"] += int((1 - tp[keep, 0]).sum())
    per_class = {}
    ap50s, aps = [], []
    for c in range(nc):
        tp = np.concatenate(records[c]["tp"]) if records[c]["tp"] else np.zeros((0, len(IOUS)))
        conf = np.concatenate(records[c]["conf"]) if records[c]["conf"] else np.zeros(0)
        ap = [average_precision(tp[:, k], conf, records[c]["n_gt"]) for k in range(len(IOUS))]
        per_class[classes[c]] = {"AP50": round(ap[0], 4), "AP50_95": round(float(np.mean(ap)), 4), "boxes": records[c]["n_gt"]}
        ap50s.append(ap[0])
        aps.append(np.mean(ap))
    return {
        "model": model.name,
        "split": split_dir.name,
        "images": len(images),
        "precision": round(op["tp"] / max(1, op["tp"] + op["fp"]), 4),
        "recall": round(op["tp"] / max(1, op["n_gt"]), 4),
        "mAP50": round(float(np.nanmean(ap50s)), 4),
        "mAP50_95": round(float(np.nanmean(aps)), 4),
        "per_class": per_class,
        "operating_conf": operating_conf,
        "mean_detect_ms": round(1e3 * float(np.mean(times)), 1),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    models = ROOT / "app" / "python" / "models"
    ap.add_argument("--model", type=Path, nargs="+", default=None, help="ONNX file(s), default: the deployed model")
    ap.add_argument("--data", type=Path, default=ROOT / "training" / "dataset")
    ap.add_argument("--split", nargs="+", default=["test"], choices=["train", "val", "test"])
    ap.add_argument("--out", type=Path, default=None, help="write the results as JSON")
    args = ap.parse_args()
    card = json.loads((models / "model_card.json").read_text())
    paths = args.model or [models / card.get("deploy", "helioscan_yolo11n.onnx")]
    results = []
    for m in paths:
        for split in args.split:
            r = evaluate(m, args.data / "images" / split, args.data / "labels" / split, card["classes"], card["input"]["size"])
            results.append(r)
            pc = "  ".join(f"{k} AP50 {v['AP50']:.3f}" for k, v in r["per_class"].items())
            print(f"{r['model']:<32} {split:<5} P {r['precision']:.3f}  R {r['recall']:.3f}  mAP50 {r['mAP50']:.3f}"
                  f"  mAP50-95 {r['mAP50_95']:.3f}  [{pc}]  {r['mean_detect_ms']} ms/img")
    if args.out:
        args.out.write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
