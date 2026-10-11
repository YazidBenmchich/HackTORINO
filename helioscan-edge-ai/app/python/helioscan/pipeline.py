"""Per-frame edge-inference pipeline.

    JPEG frame from the phone
      → decode (OpenCV)
      → panel segmentation + visible edges         (geometry.PanelSegmenter)
      → ArUco start marker                         (geometry.MarkerDetector)
      → YOLO defect detection                      (detector.YoloDetector, ONNX Runtime)
      → multi-object tracking                      (tracker.ByteTracker)
      → mission: U-path FSM + reference check      (mission.Mission)
      → result for the phone overlay + events for the microcontroller

Every stage is timed; the latencies are returned with each result.
"""

from __future__ import annotations

import base64
import json
import time
from pathlib import Path

import cv2
import numpy as np

from .detector import YoloDetector
from .geometry import MarkerDetector, PanelSegmenter
from .mission import LABELS, STEPS, Mission
from .tracker import ByteTracker

HERE = Path(__file__).resolve().parent.parent


class InspectionPipeline:
    def __init__(self, model_dir: Path = HERE / "models", profile_path: Path = HERE / "data" / "c14_profile.json",
                 threads: int = 4):
        self.profile = json.loads(Path(profile_path).read_text())
        card = json.loads((Path(model_dir) / "model_card.json").read_text())
        self.model_card = card
        self.detector = YoloDetector(Path(model_dir) / "helioscan_yolo11n.onnx", card["classes"],
                                     imgsz=card["input"]["size"], threads=threads)
        self.segmenter = PanelSegmenter()
        self.markers = MarkerDetector(self.profile["marker"]["id"])
        self.tracker = ByteTracker(high=self.detector.conf)
        self.mission = Mission(self.profile)
        self.started = time.monotonic()
        self.frames = 0

    # ------------------------------------------------------------------ settings

    def configure(self, conf: float | None = None, print_mode: str | None = None) -> dict:
        if conf is not None:
            self.detector.conf = float(min(0.95, max(0.05, conf)))
            self.tracker.high = self.detector.conf
            self.detector.floor = min(0.15, self.detector.conf * 0.5)
        if print_mode in ("bw", "color"):
            self.segmenter.print_mode = print_mode
        return {"conf": self.detector.conf, "print_mode": self.segmenter.print_mode}

    def reset(self) -> None:
        self.tracker.reset()
        self.mission.reset()

    def skip(self) -> list[dict]:
        return self.mission.skip()

    # ------------------------------------------------------------------ processing

    @staticmethod
    def decode(jpeg_b64: str) -> np.ndarray:
        if "," in jpeg_b64[:64]:
            jpeg_b64 = jpeg_b64.split(",", 1)[1]  # data URL
        buf = np.frombuffer(base64.b64decode(jpeg_b64), np.uint8)
        img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("invalid JPEG frame")
        return img

    def process(self, bgr: np.ndarray, t: float | None = None) -> dict:
        t = time.monotonic() - self.started if t is None else t
        h, w = bgr.shape[:2]
        timings = {}

        t0 = time.perf_counter()
        view = self.segmenter.analyse(bgr)
        t1 = time.perf_counter()
        marker = self.markers.detect(bgr)
        t2 = time.perf_counter()
        dets = self.detector.detect(bgr)
        t3 = time.perf_counter()
        tracks = self.tracker.update(dets, t, (w, h))
        live = self.tracker.live(t)
        events = self.mission.update(view, marker, tracks, live, t)
        t4 = time.perf_counter()
        timings = {"panel_ms": (t1 - t0) * 1e3, "marker_ms": (t2 - t1) * 1e3, "yolo_ms": (t3 - t2) * 1e3,
                   "tracking_ms": (t4 - t3) * 1e3, "total_ms": (t4 - t0) * 1e3}
        self.frames += 1

        row = self.mission.current.get("row")
        shown = []
        for tr in live:
            if tr.is_marker or (row and tr.rejected_in == row) or tr.cls not in LABELS:
                continue
            if not tr.counted and tr.conf < self.detector.conf:
                continue
            shown.append({
                "id": tr.id, "box": [round(v, 1) for v in tr.box], "type": tr.cls, "label": LABELS[tr.cls],
                "conf": round(tr.conf, 2), "confirmed": tr.confirmed, "counted": tr.counted,
                "number": tr.number, "sheet": tr.sheet,
            })
        hint, warn = self.mission.hint(view)
        step = self.mission.current
        return {
            "size": [w, h],
            "t": round(t, 3),
            "panel": {"coverage": round(view.coverage, 3), "edges": view.edges},
            "marker": [round(v, 1) for v in marker] if marker else None,
            "detections": [{"box": [round(v, 1) for v in d.box], "type": d.name, "conf": round(d.conf, 2)} for d in dets],
            "tracks": shown,
            "step": {"index": self.mission.step, "count": len(STEPS) - 1, "id": step["id"], "title": step["title"],
                     "arrow": step.get("arrow"), "end": step.get("end"), "hint": hint, "warn": warn,
                     "progress": round(self.mission.hold / self.mission.timing.marker_hold, 2) if step["id"] == "marker" else None},
            "findings": self.mission.findings,
            "done": self.mission.done,
            "events": events,
            "timings": {k: round(v, 1) for k, v in timings.items()},
        }

    def report(self) -> dict:
        expected = [{"type": d["class"], "sheet": d["sheet"]} for d in self.profile["defects"]]
        return {
            "panel_id": self.profile["panel_id"],
            "status": "defect" if self.mission.findings else "ok",
            "complete": self.mission.done,
            "findings": self.mission.findings,
            "reference": expected,
            "model": {k: self.model_card[k] for k in ("model", "classes", "validation")},
            "frames_processed": self.frames,
        }
