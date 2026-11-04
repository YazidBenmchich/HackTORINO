"""Procedural defects drawn on the clean panel: the training data never contains the printed ones.

The three defects printed on the demo panel (C14) are kept as a held-out test set. To learn the
*classes* instead of those three instances, every training panel is the blank print with new
defects drawn at random positions, sizes, shapes and colours:

bird_dropping
    Irregular cream body (polar noise contour), translucent halo, darker core, satellite droplets,
    sometimes a run-off streak.
crack
    Impact star (3-7 branches, random-walk polylines with sub-branches) or a long single crack,
    thin bright core with a soft glow.

Distractors that are *not* defects are added too (dust specks, glare, shadows), so the detector
learns to reject them. Each defect's box comes from the pixels actually drawn, so labels are exact.

All coordinates are millimetres on the assembled panel; drawing happens at `px_per_mm`.
"""

from __future__ import annotations

import math

import cv2
import numpy as np

CLASSES = ["bird_dropping", "crack"]


def _blob(rng: np.random.Generator, cx: float, cy: float, r: float, roughness: float, n: int = 48,
          stretch: tuple[float, float] = (1.0, 1.0), angle: float = 0.0) -> np.ndarray:
    """Closed irregular contour around (cx, cy): radius modulated by a few random harmonics."""
    t = np.linspace(0, 2 * np.pi, n, endpoint=False)
    rad = np.ones_like(t)
    for k in range(2, 6):
        rad += rng.uniform(0, roughness) / k * np.sin(k * t + rng.uniform(0, 2 * np.pi))
    x, y = rad * r * stretch[0] * np.cos(t), rad * r * stretch[1] * np.sin(t)
    ca, sa = math.cos(angle), math.sin(angle)
    return np.stack([cx + ca * x - sa * y, cy + sa * x + ca * y], axis=1)


class Canvas:
    """Panel image plus alpha-composited drawing, in millimetre coordinates.

    Each drawing call only touches the region around its shape and returns the pixel box where
    the drawn alpha exceeds a threshold (used for the exact label box)."""

    def __init__(self, panel: np.ndarray, px_per_mm: float):
        self.img = panel.astype(np.float32)
        self.k = px_per_mm
        self.h, self.w = panel.shape[:2]

    def _draw(self, pts_px: np.ndarray, margin_px: float, paint, color, alpha: float, blur: float):
        x0 = max(0, int(pts_px[:, 0].min() - margin_px))
        y0 = max(0, int(pts_px[:, 1].min() - margin_px))
        x1 = min(self.w, int(pts_px[:, 0].max() + margin_px) + 1)
        y1 = min(self.h, int(pts_px[:, 1].max() + margin_px) + 1)
        if x1 <= x0 or y1 <= y0:
            return None
        m = np.zeros((y1 - y0, x1 - x0), np.uint8)
        paint(m, (pts_px - (x0, y0)) * 16)
        a = m.astype(np.float32) / 255.0
        if blur > 0:
            a = cv2.GaussianBlur(a, (0, 0), blur * self.k)
        a *= alpha
        roi = self.img[y0:y1, x0:x1]
        roi[:] = roi * (1 - a[..., None]) + np.asarray(color, np.float32)[None, None, :] * a[..., None]
        ys, xs = np.nonzero(a > 0.25 * alpha)
        if len(xs) == 0:
            return None
        return (x0 + xs.min(), y0 + ys.min(), x0 + xs.max() + 1, y0 + ys.max() + 1)

    def poly(self, pts_mm, color, alpha=1.0, blur=0.15):
        pts = np.asarray(pts_mm, np.float64) * self.k
        paint = lambda m, p: cv2.fillPoly(m, [np.round(p).astype(np.int32)], 255, cv2.LINE_AA, shift=4)
        return self._draw(pts, 4 * blur * self.k + 2, paint, color, alpha, blur)

    def circle(self, c_mm, r_mm, color, alpha=1.0, blur=0.1):
        c = np.asarray([c_mm], np.float64) * self.k
        r = r_mm * self.k
        paint = lambda m, p: cv2.circle(m, tuple(int(round(v)) for v in p[0]), max(16, int(r * 16)), 255, -1, cv2.LINE_AA, shift=4)
        return self._draw(c, r + 4 * blur * self.k + 2, paint, color, alpha, blur)

    def lines(self, polylines_mm, width_mm, color, alpha=1.0, blur=0.0):
        pls = [np.asarray(p, np.float64) * self.k for p in polylines_mm]
        thick = max(1, int(round(width_mm * self.k)))
        sizes = np.cumsum([0] + [len(p) for p in pls])
        def paint(m, allp):
            parts = [np.round(allp[sizes[i]:sizes[i + 1]]).astype(np.int32) for i in range(len(pls))]
            cv2.polylines(m, parts, False, 255, thick, cv2.LINE_AA, shift=4)
        return self._draw(np.concatenate(pls), thick + 4 * blur * self.k + 2, paint, color, alpha, blur)

    def result(self) -> np.ndarray:
        return np.clip(self.img, 0, 255).astype(np.uint8)


def _box_of(boxes: list, k: float) -> list[float] | None:
    boxes = [b for b in boxes if b is not None]
    if not boxes:
        return None
    b = np.array(boxes, np.float64)
    return [round(float(v) / k, 1) for v in (b[:, 0].min(), b[:, 1].min(), b[:, 2].max(), b[:, 3].max())]


# --------------------------------------------------------------------------- defects

def draw_bird_dropping(cv: Canvas, rng: np.random.Generator, cx: float, cy: float) -> list[float] | None:
    r = rng.uniform(5, 17)
    angle = rng.uniform(0, np.pi)
    stretch = (rng.uniform(1.0, 1.6), 1.0) if rng.random() < 0.35 else (1.0, 1.0)
    b = rng.uniform(185, 230)
    g = b + rng.uniform(4, 18)
    cream = np.minimum(255, np.array([b, g, g + rng.uniform(0, 14)]))  # BGR, warm white (R >= G >= B)
    if rng.random() < 0.25:
        cream = np.full(3, rng.uniform(175, 235))  # grey-white
    alphas = []
    if rng.random() < 0.8:  # translucent halo
        halo = cream * rng.uniform(0.6, 0.85)
        alphas.append(cv.poly(_blob(rng, cx + rng.normal(0, r * 0.2), cy + rng.normal(0, r * 0.2), r * rng.uniform(1.15, 1.5),
                                    0.6, stretch=stretch, angle=angle), halo, rng.uniform(0.25, 0.5), blur=0.4))
    alphas.append(cv.poly(_blob(rng, cx, cy, r, rng.uniform(0.4, 0.9), stretch=stretch, angle=angle), cream,
                          rng.uniform(0.8, 1.0), blur=rng.uniform(0.1, 0.4)))
    if rng.random() < 0.5:  # second lobe
        a = rng.uniform(0, 2 * np.pi)
        alphas.append(cv.poly(_blob(rng, cx + math.cos(a) * r * 0.6, cy + math.sin(a) * r * 0.6, r * rng.uniform(0.4, 0.7), 0.6),
                              cream * rng.uniform(0.9, 1.0), rng.uniform(0.7, 1.0), blur=0.2))
    if rng.random() < 0.8:  # dark core
        dark = np.array([rng.uniform(60, 110), rng.uniform(70, 115), rng.uniform(80, 125)])
        cv.poly(_blob(rng, cx + rng.normal(0, r * 0.15), cy + rng.normal(0, r * 0.15), r * rng.uniform(0.2, 0.45), 1.0),
                dark, rng.uniform(0.6, 0.95), blur=0.2)
    for _ in range(rng.integers(0, 5)):  # satellite droplets
        a, d = rng.uniform(0, 2 * np.pi), r * rng.uniform(1.3, 2.4)
        alphas.append(cv.circle((cx + math.cos(a) * d, cy + math.sin(a) * d), rng.uniform(0.8, 2.2), cream, rng.uniform(0.7, 1.0)))
    return _box_of(alphas, cv.k)


def _walk(rng: np.random.Generator, x: float, y: float, heading: float, length: float, step: float = 2.5) -> np.ndarray:
    pts = [(x, y)]
    travelled = 0.0
    while travelled < length:
        heading += rng.normal(0, 0.22)
        s = step * rng.uniform(0.6, 1.4)
        x, y = x + math.cos(heading) * s, y + math.sin(heading) * s
        pts.append((x, y))
        travelled += s
    return np.array(pts)


def draw_crack(cv: Canvas, rng: np.random.Generator, cx: float, cy: float) -> list[float] | None:
    lines = []
    if rng.random() < 0.7:  # impact star
        n = int(rng.integers(3, 8))
        base = rng.uniform(0, 2 * np.pi)
        size = rng.uniform(18, 45)
        for i in range(n):
            heading = base + 2 * np.pi * i / n + rng.normal(0, 0.35)
            branch = _walk(rng, cx, cy, heading, size * rng.uniform(0.35, 1.0))
            lines.append(branch)
            if rng.random() < 0.45 and len(branch) > 4:  # sub-branch
                j = int(rng.integers(2, len(branch) - 1))
                lines.append(_walk(rng, *branch[j], heading + rng.choice([-1, 1]) * rng.uniform(0.4, 1.1),
                                   size * rng.uniform(0.15, 0.4)))
    else:  # long single crack, sometimes forked
        heading = rng.uniform(0, 2 * np.pi)
        length = rng.uniform(35, 90)
        main = _walk(rng, cx - math.cos(heading) * length / 2, cy - math.sin(heading) * length / 2, heading, length)
        lines.append(main)
        if rng.random() < 0.6:
            j = int(rng.integers(2, len(main) - 1))
            lines.append(_walk(rng, *main[j], heading + rng.choice([-1, 1]) * rng.uniform(0.3, 0.9), length * rng.uniform(0.2, 0.5)))
    tint = rng.uniform(215, 255)
    core = np.array([255, tint, tint * rng.uniform(0.9, 1.0)])  # bluish white
    glow = cv.lines(lines, rng.uniform(1.0, 2.2), core, rng.uniform(0.2, 0.45), blur=0.35)
    body = cv.lines(lines, rng.uniform(0.35, 0.9), core, rng.uniform(0.75, 1.0))
    alphas = [glow, body]
    if rng.random() < 0.6:  # crushed impact point
        alphas.append(cv.circle((cx, cy), rng.uniform(1.0, 2.5), core, 0.9, blur=0.2))
    return _box_of(alphas, cv.k)


DRAW = {"bird_dropping": draw_bird_dropping, "crack": draw_crack}


def draw_distractors(cv: Canvas, rng: np.random.Generator, glass: tuple[float, float, float, float]) -> None:
    """Things that are not defects: isolated dust specks and faint smudges."""
    x0, y0, x1, y1 = glass
    for _ in range(rng.integers(0, 6)):
        cv.circle((rng.uniform(x0, x1), rng.uniform(y0, y1)), rng.uniform(0.4, 1.2), np.full(3, rng.uniform(150, 230)),
                  rng.uniform(0.4, 0.9))
    if rng.random() < 0.3:  # faint smudge (finger mark), low contrast and blurry
        c = (rng.uniform(x0, x1), rng.uniform(y0, y1))
        cv.poly(_blob(rng, *c, rng.uniform(8, 25), 0.5), np.full(3, rng.uniform(120, 170)), rng.uniform(0.08, 0.18), blur=2.0)


def synth_panel(blank: np.ndarray, rng: np.random.Generator, px_per_mm: float, glass: tuple[float, float, float, float],
                keep_out: list[tuple[float, float, float, float]], count: int) -> tuple[np.ndarray, list[dict]]:
    """Blank panel + `count` random defects. Returns the image and the defects (class, bbox_mm)."""
    cv = Canvas(blank, px_per_mm)
    draw_distractors(cv, rng, glass)
    x0, y0, x1, y1 = glass
    placed: list[tuple[float, float]] = []
    defects = []
    for _ in range(count):
        cls = CLASSES[int(rng.random() < 0.45)]
        for _try in range(40):
            cx, cy = rng.uniform(x0 + 20, x1 - 20), rng.uniform(y0 + 20, y1 - 20)
            if any(kx0 - 30 < cx < kx1 + 30 and ky0 - 30 < cy < ky1 + 30 for kx0, ky0, kx1, ky1 in keep_out):
                continue
            if all(math.hypot(cx - px, cy - py) > 75 for px, py in placed):
                break
        else:
            continue
        box = DRAW[cls](cv, rng, cx, cy)
        if box is not None:
            placed.append((cx, cy))
            defects.append({"class": cls, "bbox_mm": box})
    return cv.result(), defects
