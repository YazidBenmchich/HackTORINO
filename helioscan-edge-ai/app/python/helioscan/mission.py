"""Inspection mission: the drone's U-shaped coverage path and reference-based verification.

Path (finite-state machine)
    MARKER → RIGHT (top edge) → DOWN (right edge) → LEFT (bottom edge) → DONE
    The mission starts on the ArUco marker (top-left corner of the panel). Each turn is
    triggered when the next edge of the panel becomes visible (corner reached), after the
    edge has first been out of view for a moment (prevents an immediate turn).

Reference-based verification
    The panel's reference profile (digital twin of the printed C14 panel, generated from the
    PDFs) lists which defects exist on each row of sheets. A confirmed track is counted only
    if it fills a free slot of the row being inspected; anything else (a second piece of a
    crack, a reflection) is rejected for this row and re-examined on the next row. The start
    marker, once seen, is followed and can never be counted as a defect.
"""

from __future__ import annotations

from dataclasses import dataclass

from .geometry import PanelView
from .tracker import Track, overlaps

STEPS = [
    {"id": "marker", "title": "Find the start marker", "hint": "Aim at the black & white marker in the top-left corner"},
    {"id": "right", "title": "Move right", "arrow": "→", "follow": "top", "end": "right", "row": "top", "pass": "top pass",
     "hint": "Follow the top edge to the top-right corner"},
    {"id": "down", "title": "Move down", "arrow": "↓", "follow": "right", "end": "bottom", "row": "bottom", "pass": "right side",
     "hint": "Follow the right edge to the bottom-right corner"},
    {"id": "left", "title": "Move left", "arrow": "←", "follow": "bottom", "end": "left", "row": "bottom", "pass": "bottom pass",
     "hint": "Follow the bottom edge to the bottom-left corner"},
    {"id": "done", "title": "Scan complete"},
]

LABELS = {"bird_dropping": "Bird dropping", "crack": "Crack"}


@dataclass
class Timing:
    marker_hold: float = 0.5    # s on the marker before starting
    marker_memory: float = 1.0  # s the marker position is kept after its last detection
    arm_time: float = 0.6       # s without the arrival edge before it can trigger a turn
    edge_hold: float = 0.5      # s with the arrival edge visible: corner reached
    min_coverage: float = 0.25


class Mission:
    def __init__(self, profile: dict, timing: Timing | None = None):
        self.profile = profile
        self.timing = timing or Timing()
        self.reset()

    def reset(self) -> None:
        sheet_h = self.profile["sheet_mm"][1]
        self.slots = {"top": [], "bottom": []}
        for d in self.profile["defects"]:
            row = "top" if d["bbox_mm"][1] < sheet_h else "bottom"
            self.slots[row].append({"type": d["class"], "sheet": d["sheet"], "used": False})
        self.step = 0
        self.hold = self.away = 0.0
        self.armed = False
        self.marker_box: list[float] | None = None
        self.marker_seen = -1e9
        self.findings: list[dict] = []
        self.last_t: float | None = None

    @property
    def current(self) -> dict:
        return STEPS[self.step]

    @property
    def scanning(self) -> bool:
        return 1 <= self.step <= 3

    @property
    def done(self) -> bool:
        return self.step == len(STEPS) - 1

    def skip(self) -> list[dict]:
        if self.done:
            return []
        self._advance()
        return [{"type": "step", "step": self.current["id"]}]

    def _advance(self) -> None:
        self.step += 1
        self.hold = self.away = 0.0
        self.armed = False

    def protect_marker(self, marker: list[float] | None, tracks: list[Track], t: float) -> None:
        """Remember the marker and flag every track lying on it (never a defect)."""
        if marker is not None:
            self.marker_box, self.marker_seen = marker, t
        if self.marker_box is None or t - self.marker_seen > self.timing.marker_memory:
            return
        pad = 0.1 * max(self.marker_box[2] - self.marker_box[0], self.marker_box[3] - self.marker_box[1])
        for tr in tracks:
            if not tr.counted and overlaps(tr.box, self.marker_box, pad):
                tr.is_marker = True

    def update(self, view: PanelView, marker: list[float] | None, tracks: list[Track], live: list[Track], t: float) -> list[dict]:
        events: list[dict] = []
        dt = 0.0 if self.last_t is None else min(0.5, t - self.last_t)
        self.last_t = t
        if self.done:
            return events

        self.protect_marker(marker, tracks, t)

        if self.scanning:
            row = self.current["row"]
            for tr in live:
                if not tr.confirmed or tr.counted or tr.is_marker or tr.rejected_in == row:
                    continue
                slot = next((s for s in self.slots[row] if not s["used"] and s["type"] == tr.cls), None)
                if slot is None:
                    tr.rejected_in = row  # not expected on this row (or already found): re-examined on the next row
                    continue
                slot["used"] = True
                tr.counted = True
                tr.number = len(self.findings) + 1
                tr.sheet = slot["sheet"]
                finding = {"number": tr.number, "type": slot["type"], "label": LABELS[slot["type"]],
                           "sheet": slot["sheet"], "pass": self.current["pass"], "confidence": round(tr.conf, 2), "time": round(t, 2)}
                self.findings.append(finding)
                events.append({"type": "defect", "finding": finding})

        s = self.current
        in_view = view.coverage >= self.timing.min_coverage
        if s["id"] == "marker":
            self.hold = self.hold + dt if (marker is not None and in_view) else 0.0
            if self.hold >= self.timing.marker_hold:
                self._advance()
        elif in_view:
            if not view.edges[s["end"]]:
                self.away += dt
                if self.away >= self.timing.arm_time:
                    self.armed = True
                self.hold = 0.0
            elif self.armed:
                self.hold += dt
                if self.hold >= self.timing.edge_hold:
                    self._advance()
        if self.current is not s:
            events.append({"type": "step", "step": self.current["id"]})
        return events

    def hint(self, view: PanelView) -> tuple[str, bool]:
        s = self.current
        if self.done:
            return "", False
        if view.coverage < self.timing.min_coverage:
            return "Point the camera at the panel (closer)", True
        if s.get("follow") and not view.edges[s["follow"]]:
            return f"Keep the {s['follow']} edge of the panel in view", True
        if s.get("end") and view.edges[s["end"]] and self.armed:
            return "Corner reached…", False
        return s.get("hint", ""), False
