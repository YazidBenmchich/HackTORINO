"""Inspection mission: the drone's U-shaped coverage path and a defect map in panel coordinates.

Path (finite-state machine)
    MARKER → RIGHT (top edge) → DOWN (right edge) → LEFT (bottom edge) → DONE
    The mission starts on the ArUco marker (top-left corner of the panel). Each turn is
    triggered when the next edge of the panel becomes visible (corner reached), after the
    edge has first been out of view for a moment (prevents an immediate turn).

Defect map
    Every confirmed track is projected onto the panel with the camera pose (localization.py).
    Observations are merged by position in millimetres, not by track: the same crack seen again
    after the tracker lost it is still one defect. Each defect is reported once, with its
    measured position, solar cell (R<row>-C<col>) and sheet. Anything outside the glass or on
    the start marker's label is ignored by geometry.

Coverage
    A cell counts as inspected once its centre has been in the central part of a localised view.

Reference check (report only)
    The panel's reference profile (where the printed defects really are) grades the scan after
    the fact: matched, missed and unexpected defects, and the position error of each match.
    It never decides what is reported.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .geometry import PanelView
from .localization import Pose
from .tracker import Track, overlaps

STEPS = [
    {"id": "marker", "title": "Find the start marker", "hint": "Aim at the black & white marker in the top-left corner"},
    {"id": "right", "title": "Move right", "arrow": "→", "follow": "top", "end": "right", "pass": "top pass",
     "hint": "Follow the top edge to the top-right corner"},
    {"id": "down", "title": "Move down", "arrow": "↓", "follow": "right", "end": "bottom", "pass": "right side",
     "hint": "Follow the right edge to the bottom-right corner"},
    {"id": "left", "title": "Move left", "arrow": "←", "follow": "bottom", "end": "left", "pass": "bottom pass",
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


@dataclass
class PanelDefect:
    number: int
    votes: dict
    xy: np.ndarray                      # centre on the panel, mm (running mean)
    box: list[float]                    # x0, y0, x1, y1 on the panel, mm (last full view)
    conf: float
    found_at: float
    found_in: str
    weight: float = 1.0
    tracks: set = field(default_factory=set)

    @property
    def cls(self) -> str:
        return max(self.votes, key=self.votes.get)


class PanelGeometry:
    """Cells, sheets and keep-out zones of the panel, from its reference profile (mm)."""

    def __init__(self, profile: dict):
        self.glass = profile.get("glass_mm", [12.0, 12.0, profile["panel_mm"][0] - 12.0, profile["panel_mm"][1] - 12.0])
        self.cols, self.rows = profile.get("cells", [12, 6])
        self.sheet_mm = profile["sheet_mm"]
        self.sheets = profile["sheets"]
        m = np.asarray(profile["marker"]["corners_mm"])
        pad = 0.2 * (m[:, 0].max() - m[:, 0].min())  # white quiet zone of the printed label
        self.label = [m[:, 0].min() - pad, m[:, 1].min() - pad, m[:, 0].max() + pad, m[:, 1].max() + pad]
        gx0, gy0, gx1, gy1 = self.glass
        self.cell_w, self.cell_h = (gx1 - gx0) / self.cols, (gy1 - gy0) / self.rows
        self.cell_centres = np.array([[gx0 + (c + 0.5) * self.cell_w, gy0 + (r + 0.5) * self.cell_h]
                                      for r in range(self.rows) for c in range(self.cols)], np.float32)

    def cell(self, x: float, y: float) -> str:
        c = int(np.clip((x - self.glass[0]) // self.cell_w, 0, self.cols - 1))
        r = int(np.clip((y - self.glass[1]) // self.cell_h, 0, self.rows - 1))
        return f"R{r + 1}-C{c + 1}"

    def sheet(self, x: float, y: float) -> str:
        c = int(np.clip(x // self.sheet_mm[0], 0, len(self.sheets[0]) - 1))
        r = int(np.clip(y // self.sheet_mm[1], 0, len(self.sheets) - 1))
        return self.sheets[r][c]

    def on_glass(self, x: float, y: float, margin: float = 2.0) -> bool:
        gx0, gy0, gx1, gy1 = self.glass
        return gx0 - margin <= x <= gx1 + margin and gy0 - margin <= y <= gy1 + margin

    def on_label(self, box_mm) -> bool:
        return overlaps(box_mm, self.label, 0.0)


class Mission:
    def __init__(self, profile: dict, timing: Timing | None = None, merge_mm: float = 40.0):
        self.profile = profile
        self.geo = PanelGeometry(profile)
        self.timing = timing or Timing()
        self.merge_mm = merge_mm
        self.reset()

    def reset(self) -> None:
        self.step = 0
        self.hold = self.away = 0.0
        self.armed = False
        self.marker_box: list[float] | None = None
        self.marker_seen = -1e9
        self.defects: list[PanelDefect] = []
        self.inspected = np.zeros(len(self.geo.cell_centres), bool)
        self.pose_lost = False
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

    # ------------------------------------------------------------------ findings

    def finding(self, d: PanelDefect) -> dict:
        x, y = (float(v) for v in d.xy)
        return {"number": d.number, "type": d.cls, "label": LABELS[d.cls], "cell": self.geo.cell(x, y),
                "sheet": self.geo.sheet(x, y), "position_mm": [round(x, 1), round(y, 1)],
                "box_mm": [round(v, 1) for v in d.box], "pass": d.found_in, "confidence": round(d.conf, 2),
                "time": round(d.found_at, 2)}

    @property
    def findings(self) -> list[dict]:
        return [self.finding(d) for d in self.defects]

    def protect_marker(self, marker: list[float] | None, tracks: list[Track], t: float) -> None:
        """Remember the marker's image box and flag every track lying on it (display only)."""
        if marker is not None:
            self.marker_box, self.marker_seen = marker, t
        if self.marker_box is None or t - self.marker_seen > self.timing.marker_memory:
            return
        pad = 0.1 * max(self.marker_box[2] - self.marker_box[0], self.marker_box[3] - self.marker_box[1])
        for tr in tracks:
            if tr.defect is None and overlaps(tr.box, self.marker_box, pad):
                tr.is_marker = True

    def _map(self, tr: Track, pose: Pose, size: tuple[int, int], t: float) -> dict | None:
        x0, y0, x1, y1 = tr.box
        q = pose.to_panel([[x0, y0], [x1, y0], [x1, y1], [x0, y1]])
        box = [float(q[:, 0].min()), float(q[:, 1].min()), float(q[:, 0].max()), float(q[:, 1].max())]
        cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
        if not self.geo.on_glass(cx, cy) or self.geo.on_label(box):
            tr.is_marker = tr.is_marker or self.geo.on_label(box)
            return None
        w, h = size
        clipped = x0 < 3 or y0 < 3 or x1 > w - 3 or y1 > h - 3  # partly out of view: centre is biased

        def same(d: PanelDefect) -> bool:
            return np.hypot(*(d.xy - (cx, cy))) < self.merge_mm or overlaps(d.box, box, 0.0)

        if tr.defect is not None and not same(self.defects[tr.defect - 1]):
            tr.defect = None  # the track jumped to another object: never average two defects together
        if tr.defect is None:
            near = [d for d in self.defects if same(d)]
            d = min(near, key=lambda d: np.hypot(*(d.xy - (cx, cy))), default=None)
            if d is None:
                d = PanelDefect(len(self.defects) + 1, dict(tr.votes), np.array([cx, cy]), box, tr.conf, t,
                                self.current.get("pass", "start"), weight=0.2 if clipped else 1.0)
                self.defects.append(d)
                tr.defect = d.number
                return {"type": "defect", "finding": self.finding(d)}
            tr.defect = d.number
        d = self.defects[tr.defect - 1]
        d.tracks.add(tr.id)
        d.votes[tr.cls] = d.votes.get(tr.cls, 0.0) + tr.conf
        d.conf = max(d.conf, tr.conf)
        wgt = 0.2 if clipped else 1.0
        d.xy = (d.xy * d.weight + np.array([cx, cy]) * wgt) / (d.weight + wgt)
        d.weight = min(d.weight + wgt, 30.0)  # bounded memory: late, better views still count
        if not clipped:
            d.box = box
        return None

    def _cover(self, pose: Pose, size: tuple[int, int]) -> None:
        w, h = size
        p = pose.to_image(self.geo.cell_centres)
        inside = (p[:, 0] > 0.1 * w) & (p[:, 0] < 0.9 * w) & (p[:, 1] > 0.1 * h) & (p[:, 1] < 0.9 * h)
        self.inspected |= inside

    # ------------------------------------------------------------------ update

    def update(self, view: PanelView, marker: list[float] | None, pose: Pose, tracks: list[Track], live: list[Track],
               t: float, size: tuple[int, int]) -> list[dict]:
        events: list[dict] = []
        dt = 0.0 if self.last_t is None else min(0.5, t - self.last_t)
        self.last_t = t
        if self.done:
            return events

        self.protect_marker(marker, tracks, t)
        self.pose_lost = self.scanning and not pose.ok
        if pose.ok and self.step >= 1:
            self._cover(pose, size)
            for tr in live:
                if tr.confirmed and tr.last_seen == t:
                    e = self._map(tr, pose, size, t)
                    if e:
                        events.append(e)

        s = self.current
        in_view = view.coverage >= self.timing.min_coverage
        if s["id"] == "marker":
            self.hold = self.hold + dt if (marker is not None and in_view and pose.ok) else 0.0
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
        if self.pose_lost:
            return "Position lost: go back to the start marker", True
        if view.coverage < self.timing.min_coverage:
            return "Point the camera at the panel (closer)", True
        if s.get("follow") and not view.edges[s["follow"]]:
            return f"Keep the {s['follow']} edge of the panel in view", True
        if s.get("end") and view.edges[s["end"]] and self.armed:
            return "Corner reached…", False
        return s.get("hint", ""), False

    # ------------------------------------------------------------------ report

    def coverage(self) -> dict:
        missed = [self.geo.cell(*c) for c, ok in zip(self.geo.cell_centres, self.inspected) if not ok]
        return {"inspected": int(self.inspected.sum()), "cells": len(self.inspected), "missed": missed}

    def grade(self, match_mm: float = 40.0) -> dict:
        """Compare the findings with the reference profile (where the defects really are)."""
        refs = [dict(r, xy=((r["bbox_mm"][0] + r["bbox_mm"][2]) / 2, (r["bbox_mm"][1] + r["bbox_mm"][3]) / 2))
                for r in self.profile.get("defects", [])]
        pairs = sorted((float(np.hypot(*(d.xy - r["xy"]))), i, j)
                       for i, d in enumerate(self.defects) for j, r in enumerate(refs))
        used_d, used_r, matched = set(), set(), []
        for dist, i, j in pairs:
            if dist > match_mm or i in used_d or j in used_r:
                continue
            used_d.add(i)
            used_r.add(j)
            d, r = self.defects[i], refs[j]
            matched.append({"number": d.number, "type": d.cls, "expected_type": r["class"], "type_ok": d.cls == r["class"],
                            "cell": self.geo.cell(*r["xy"]), "error_mm": round(dist, 1)})
        return {
            "matched": matched,
            "missed": [{"type": r["class"], "cell": self.geo.cell(*r["xy"]), "sheet": r["sheet"]}
                       for j, r in enumerate(refs) if j not in used_r],
            "unexpected": [self.finding(d) for i, d in enumerate(self.defects) if i not in used_d],
        }
