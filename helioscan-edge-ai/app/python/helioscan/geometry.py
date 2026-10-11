"""Panel segmentation, visible-edge detection and ArUco start-marker localisation.

Panel segmentation
    Black-and-white print: the panel is the dark region of the image. The dark / light split is
    chosen per frame with Otsu's method, so it follows the camera exposure.
    Colour print: the panel is the blue region (cell colour rule).
    The mask is evaluated on a coarse block grid; enclosed light regions (defects, marker) are
    filled so that they count as panel.

Visible edges
    A band outside the panel (frame surroundings, table, paper) along one side of the image
    means the corresponding edge of the panel is in view. The inspection path turns when the
    next edge appears (corner reached).

Start marker
    OpenCV ArUco detector, dictionary ARUCO_MIP_36h12, marker id checked against the panel's
    reference profile.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

SIDES = ("top", "right", "bottom", "left")


@dataclass
class PanelView:
    coverage: float = 0.0
    margins: dict = field(default_factory=lambda: {s: 1.0 for s in SIDES})
    edges: dict = field(default_factory=lambda: {s: False for s in SIDES})


class PanelSegmenter:
    def __init__(self, print_mode: str = "bw", grid_width: int = 64, block_fraction: float = 0.35,
                 row_fraction: float = 0.3, edge_margin: float = 0.04, min_coverage: float = 0.25):
        self.print_mode = print_mode
        self.grid_width = grid_width
        self.block_fraction = block_fraction
        self.row_fraction = row_fraction
        self.edge_margin = edge_margin
        self.min_coverage = min_coverage

    def _panel_pixels(self, small: np.ndarray) -> np.ndarray:
        if self.print_mode == "color":
            b, g, r = (small[..., i].astype(np.int16) for i in range(3))
            return (b >= 30) & (b - r >= np.maximum(14, 0.25 * b)) & (b - g >= 4)
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        t, _ = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        return gray < t

    def analyse(self, bgr: np.ndarray) -> PanelView:
        h, w = bgr.shape[:2]
        gw = self.grid_width
        gh = max(1, round(gw * h / w))
        # 4 x 4 pixels per block at the working resolution
        small = cv2.resize(bgr, (gw * 4, gh * 4), interpolation=cv2.INTER_AREA)
        pix = self._panel_pixels(small).astype(np.float32)
        blocks = pix.reshape(gh, 4, gw, 4).mean(axis=(1, 3)) >= self.block_fraction

        # Fill enclosed non-panel regions (defects, marker): flood the outside from the border
        outside = (~blocks).astype(np.uint8)
        flood = np.zeros((gh + 2, gw + 2), np.uint8)
        reach = outside.copy()
        for y in range(gh):
            for x in (0, gw - 1):
                if reach[y, x] == 1:
                    cv2.floodFill(reach, flood, (x, y), 2)
        for x in range(gw):
            for y in (0, gh - 1):
                if reach[y, x] == 1:
                    cv2.floodFill(reach, flood, (x, y), 2)
        panel = reach != 2

        coverage = float(panel.mean())
        row = panel.mean(axis=1)
        col = panel.mean(axis=0)

        def lead(fracs: np.ndarray) -> float:
            k = 0
            while k < len(fracs) and fracs[k] < self.row_fraction:
                k += 1
            return k / len(fracs)

        margins = {"top": lead(row), "bottom": lead(row[::-1]), "left": lead(col), "right": lead(col[::-1])}
        ok = coverage >= self.min_coverage
        edges = {s: bool(ok and self.edge_margin <= m < 0.9) for s, m in margins.items()}
        return PanelView(coverage, margins, edges)


class MarkerDetector:
    def __init__(self, marker_id: int | None = None):
        params = cv2.aruco.DetectorParameters()
        params.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX
        self.detector = cv2.aruco.ArucoDetector(cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_ARUCO_MIP_36h12), params)
        self.marker_id = marker_id

    def detect(self, bgr: np.ndarray) -> list[float] | None:
        """Bounding box (x0, y0, x1, y1) of the start marker, or None."""
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        corners, ids, _ = self.detector.detectMarkers(gray)
        if ids is None:
            return None
        for c, i in zip(corners, ids.reshape(-1)):
            if self.marker_id is None or int(i) == self.marker_id:
                pts = c.reshape(-1, 2)
                x0, y0 = pts.min(axis=0)
                x1, y1 = pts.max(axis=0)
                # The printed marker has a white quiet zone around the black square
                pad = 0.15 * max(x1 - x0, y1 - y0)
                return [float(x0 - pad), float(y0 - pad), float(x1 + pad), float(y1 + pad)]
        return None
