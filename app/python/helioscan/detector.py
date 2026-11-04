"""YOLO object detector running on the UNO Q CPU with ONNX Runtime.

Pre-processing  : letterbox resize to the network input (aspect ratio kept, grey padding),
                  BGR → RGB, HWC → NCHW, scaled to 0..1.
Inference       : one ONNX Runtime session, multi-threaded on the Cortex-A53 cores.
Post-processing : decode the YOLO head (cx, cy, w, h + one score per class), confidence
                  filtering, class-aware non-maximum suppression, boxes mapped back to the
                  original image.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort


@dataclass
class Detection:
    cls: int
    name: str
    conf: float
    box: tuple[float, float, float, float]  # x0, y0, x1, y1 in image pixels

    @property
    def center(self) -> tuple[float, float]:
        return (self.box[0] + self.box[2]) / 2, (self.box[1] + self.box[3]) / 2


class YoloDetector:
    def __init__(self, model_path: Path, classes: list[str], imgsz: int = 320,
                 conf: float = 0.35, iou: float = 0.5, floor: float = 0.15, threads: int = 4):
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = threads
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.session = ort.InferenceSession(str(model_path), opts, providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name
        self.classes = classes
        self.imgsz = imgsz
        self.conf = conf      # detections reported as defects
        self.floor = floor    # weaker detections kept for the tracker's second association stage
        self.iou = iou

    def _letterbox(self, img: np.ndarray) -> tuple[np.ndarray, float, float, float]:
        h, w = img.shape[:2]
        r = min(self.imgsz / h, self.imgsz / w)
        nw, nh = round(w * r), round(h * r)
        px, py = (self.imgsz - nw) / 2, (self.imgsz - nh) / 2
        canvas = np.full((self.imgsz, self.imgsz, 3), 114, np.uint8)
        x0, y0 = int(round(px - 0.1)), int(round(py - 0.1))
        canvas[y0:y0 + nh, x0:x0 + nw] = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR)
        return canvas, r, x0, y0

    def detect(self, bgr: np.ndarray) -> list[Detection]:
        canvas, r, px, py = self._letterbox(bgr)
        blob = cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB).transpose(2, 0, 1)[None].astype(np.float32) / 255.0
        out = self.session.run(None, {self.input_name: blob})[0][0].T  # (anchors, 4 + nc)
        scores = out[:, 4:]
        cls = scores.argmax(axis=1)
        conf = scores[np.arange(len(cls)), cls]
        keep = conf >= self.floor
        if not keep.any():
            return []
        xywh, cls, conf = out[keep, :4], cls[keep], conf[keep]
        x0 = (xywh[:, 0] - xywh[:, 2] / 2 - px) / r
        y0 = (xywh[:, 1] - xywh[:, 3] / 2 - py) / r
        bw, bh = xywh[:, 2] / r, xywh[:, 3] / r
        # Class-aware NMS: shift each class to its own region so boxes of different classes never suppress each other
        offset = cls.astype(np.float32) * 10000.0
        rects = np.stack([x0 + offset, y0, bw, bh], axis=1).tolist()
        idx = cv2.dnn.NMSBoxes(rects, conf.tolist(), self.floor, self.iou)
        h, w = bgr.shape[:2]
        dets = []
        for i in np.array(idx).reshape(-1):
            c = int(cls[i])
            box = (max(0.0, float(x0[i])), max(0.0, float(y0[i])),
                   min(float(w), float(x0[i] + bw[i])), min(float(h), float(y0[i] + bh[i])))
            dets.append(Detection(c, self.classes[c], float(conf[i]), box))
        return dets
