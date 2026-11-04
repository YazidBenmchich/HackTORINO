"""Message handlers shared by the Arduino App Lab app (main.py) and the local test server.

Messages from the phone (Socket.IO)
    frame   {"id": int, "jpeg": base64}        → result of the pipeline (sent back as frame_response)
    config  {"conf": float, "print_mode": str} → active settings
    reset   {}                                 → new inspection
    skip    {}                                 → manual jump to the next path step (demo fallback)
    report  {}                                 → inspection report (JSON)
"""

from __future__ import annotations

import logging
import threading
from typing import Callable

from .pipeline import InspectionPipeline

log = logging.getLogger("helioscan")


class InspectionService:
    def __init__(self, pipeline: InspectionPipeline, notify_mcu: Callable[[str, int], None] | None = None):
        self.pipeline = pipeline
        self.notify_mcu = notify_mcu
        self.lock = threading.Lock()  # one frame at a time through the pipeline

    def _mcu(self, method: str, value: int) -> None:
        if self.notify_mcu is None:
            return
        # Never block the frame handler on the microcontroller link
        threading.Thread(target=self._mcu_call, args=(method, value), daemon=True).start()

    def _mcu_call(self, method: str, value: int) -> None:
        try:
            self.notify_mcu(method, value)
        except Exception as exc:  # the inspection keeps running without the MCU
            log.warning("MCU call %s failed: %s", method, exc)

    def on_frame(self, sid, data) -> dict:
        try:
            img = self.pipeline.decode(data["jpeg"])
        except Exception as exc:
            return {"id": data.get("id") if isinstance(data, dict) else None, "error": str(exc)}
        with self.lock:
            res = self.pipeline.process(img)
        res["id"] = data.get("id")
        for e in res["events"]:
            if e["type"] == "defect":
                self._mcu("defect_alert", e["finding"]["number"])
            elif e["type"] == "step":
                self._mcu("scan_state", 2 if res["done"] else 1)
        return res

    def on_config(self, sid, data) -> dict:
        data = data or {}
        with self.lock:
            return self.pipeline.configure(data.get("conf"), data.get("print_mode"))

    def on_reset(self, sid, data) -> dict:
        with self.lock:
            self.pipeline.reset()
        self._mcu("scan_state", 0)
        return {"ok": True}

    def on_skip(self, sid, data) -> dict:
        with self.lock:
            events = self.pipeline.skip()
        if self.pipeline.mission.done:
            self._mcu("scan_state", 2)
        return {"events": events, "done": self.pipeline.mission.done}

    def on_report(self, sid=None, data=None) -> dict:
        with self.lock:
            return self.pipeline.report()

    def handlers(self) -> dict:
        return {"frame": self.on_frame, "config": self.on_config, "reset": self.on_reset,
                "skip": self.on_skip, "report": self.on_report}
