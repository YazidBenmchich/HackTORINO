"""Per-frame edge-inference pipeline.

    JPEG frame from the phone
      → decode (OpenCV)
      → panel segmentation + visible edges         (geometry.PanelSegmenter)
      → ArUco start marker                         (geometry.MarkerDetector)
      → camera pose on the panel                   (localization.PanelLocalizer)
      → YOLO defect detection                      (detector.YoloDetector, ONNX Runtime)
      → multi-object tracking                      (tracker.ByteTracker)
      → mission: U path + defect map in mm         (mission.Mission)
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
from .localization import PanelLocalizer, PanelMap
from .mission import LABELS, STEPS, Mission
from .tracker import ByteTracker

HERE = Path(__file__).resolve().parent.parent


class InspectionPipeline:
    def __init__(self, model_dir: Path = HERE / "models", profile_path: Path = HERE / "data" / "c14_profile.json",
                 model_file: str | None = None, threads: int = 4):
        self.profile = json.loads(Path(profile_path).read_text())
        card = json.loads((Path(model_dir) / "model_card.json").read_text())
        self.model_card = card
        self.model_file = model_file or card.get("deploy", "helioscan_yolo11n.onnx")
        self.detector = YoloDetector(Path(model_dir) / self.model_file, card["classes"],
                                     imgsz=card["input"]["size"], threads=threads)
        self.segmenter = PanelSegmenter()
        self.markers = MarkerDetector(self.profile["marker"]["id"])
        m = self.profile.get("map")
        panel_map = PanelMap(Path(profile_path).parent / m["file"], m["px_per_mm"]) if m else None
        self.localizer = PanelLocalizer(self.profile["marker"]["corners_mm"], panel_map)
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
        self.localizer.reset()
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

        t0 = time.perf_counter()
        view = self.segmenter.analyse(bgr)
        t1 = time.perf_counter()
        found = self.markers.detect(bgr)
        marker, corners = found if found else (None, None)
        t2 = time.perf_counter()
        pose = self.localizer.update(bgr, corners)
        t3 = time.perf_counter()
        dets = self.detector.detect(bgr)
        t4 = time.perf_counter()
        tracks = self.tracker.update(dets, t, (w, h))
        live = self.tracker.live(t)
        events = self.mission.update(view, marker, pose, tracks, live, t, (w, h))
        t5 = time.perf_counter()
        timings = {"panel_ms": (t1 - t0) * 1e3, "marker_ms": (t2 - t1) * 1e3, "pose_ms": (t3 - t2) * 1e3,
                   "yolo_ms": (t4 - t3) * 1e3, "tracking_ms": (t5 - t4) * 1e3, "total_ms": (t5 - t0) * 1e3}
        self.frames += 1

        defects = {d.number: d for d in self.mission.defects}
        shown = []
        for tr in live:
            if tr.is_marker or tr.cls not in LABELS:
                continue
            if tr.defect is None and tr.conf < self.detector.conf:
                continue
            d = defects.get(tr.defect)
            shown.append({
                "id": tr.id, "box": [round(v, 1) for v in tr.box], "type": d.cls if d else tr.cls,
                "label": LABELS[d.cls if d else tr.cls], "conf": round(tr.conf, 2), "confirmed": tr.confirmed,
                "counted": d is not None, "number": tr.defect or 0,
                "cell": self.mission.geo.cell(*d.xy) if d else None,
            })
        hint, warn = self.mission.hint(view)
        step = self.mission.current
        return {
            "size": [w, h],
            "t": round(t, 3),
            "panel": {"coverage": round(view.coverage, 3), "edges": view.edges},
            "pose": {"status": pose.status, "map_locked": pose.map_locked, "since_anchor": pose.since_anchor},
            "marker": [round(v, 1) for v in marker] if marker else None,
            "detections": [{"box": [round(v, 1) for v in d.box], "type": d.name, "conf": round(d.conf, 2)} for d in dets],
            "tracks": shown,
            "step": {"index": self.mission.step, "count": len(STEPS) - 1, "id": step["id"], "title": step["title"],
                     "arrow": step.get("arrow"), "end": step.get("end"), "hint": hint, "warn": warn,
                     "progress": round(self.mission.hold / self.mission.timing.marker_hold, 2) if step["id"] == "marker" else None},
            "findings": self.mission.findings,
            "coverage": self.mission.coverage()["inspected"],
            "done": self.mission.done,
            "events": events,
            "timings": {k: round(v, 1) for k, v in timings.items()},
        }

    def report(self) -> dict:
        findings = self.mission.findings
        return {
            "panel_id": self.profile["panel_id"],
            "status": "defect" if findings else "ok",
            "complete": self.mission.done,
            "findings": findings,
            "coverage": self.mission.coverage(),
            "reference_check": self.mission.grade(),
            "model": {"file": self.model_file, **{k: self.model_card[k] for k in ("model", "classes", "test")
                                                  if k in self.model_card}},
            "frames_processed": self.frames,
        }
