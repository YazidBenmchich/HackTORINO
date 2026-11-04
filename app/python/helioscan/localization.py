"""Where is the camera on the panel? Image pixels → panel millimetres, frame after frame.

The pose is a homography H that maps image pixels to panel millimetres (the panel is flat, so a
homography is exact for a pinhole camera). Three sources of information are fused:

Anchor        The ArUco start marker has known corners on the panel (reference profile). When it
              is in view, the pose is solved from its four corners as an affine transform: the
              marker is small (40 mm), so a full homography would get position, rotation and scale
              right but amplify corner noise in its perspective terms (millimetres of error 15 cm
              away). The map registration then fits the whole view, perspective included.
Odometry      Between anchors, the camera's motion is measured on the image itself: corners are
              tracked from the previous frame with pyramidal Lucas-Kanade optical flow, and a
              RANSAC homography between the two frames is chained onto the pose:
                  H_k = H_(k-1) · H_(k → k-1)
              The flow is seeded by a constant-velocity prediction, or by the global shift from
              phase correlation when the camera starts, stops or jumps: on the busbars, which
              repeat every ~17 mm, an unseeded flow can lock one busbar off.
              On its own this drifts: small errors accumulate, mostly when the camera rotates or
              changes height.
Map           The layout of a healthy panel is known (a grey map, 1 px/mm). The camera view is
              rectified into panel coordinates with the current pose and aligned to the map crop
              with ECC (enhanced correlation coefficient: insensitive to exposure and print
              contrast). The residual warp corrects the pose, so the drift stays bounded without
              the marker. Two details keep it from locking onto the wrong place:
              - the busbars repeat every ~17 mm, so a correction larger than a few millimetres
                is refused (odometry drifts well under 1 mm per frame, so a true correction is
                always small);
              - defects and glare are not in the map: pixels that disagree strongly with it are
                masked out before the fit, otherwise a bird dropping drags the alignment.
Lost          No marker, odometry failed and the map does not confirm the predicted pose: the
              pose is dropped until the marker is seen again.

Every frame reports a status ("anchored", "tracking", "lost") and whether the map confirmed it.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np


@dataclass
class Pose:
    H: np.ndarray | None        # image px → panel mm, None when lost
    status: str                 # "anchored" | "tracking" | "lost"
    since_anchor: int           # frames since the last marker anchor
    inliers: int = 0
    map_locked: bool = False    # the map registration confirmed this pose

    @property
    def ok(self) -> bool:
        return self.H is not None

    def to_panel(self, pts_px) -> np.ndarray:
        pts = np.asarray(pts_px, np.float32).reshape(-1, 1, 2)
        return cv2.perspectiveTransform(pts, self.H).reshape(-1, 2)

    def to_image(self, pts_mm) -> np.ndarray:
        pts = np.asarray(pts_mm, np.float32).reshape(-1, 1, 2)
        return cv2.perspectiveTransform(pts, np.linalg.inv(self.H)).reshape(-1, 2)


class PanelMap:
    """Grey image of the healthy panel, and ECC registration of a camera view against it."""

    def __init__(self, path: Path, px_per_mm: float = 1.0, work_px_per_mm: float = 0.75,
                 max_correction_mm: float = 6.0):
        img = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
        if img is None:
            raise FileNotFoundError(path)
        self.k = work_px_per_mm   # registration resolution: the busbars are still resolved at 0.75 px/mm
        f = work_px_per_mm / px_per_mm
        self.img = cv2.resize(img, None, fx=f, fy=f, interpolation=cv2.INTER_AREA).astype(np.float32)
        self.h, self.w = self.img.shape
        self.max_correction = max_correction_mm
        self.criteria = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 1e-4)
        self.motion = cv2.MOTION_AFFINE  # a homography fit is less stable for the same accuracy
        self.min_score = 0.8      # good fits score > 0.95; below this the view does not match the map
        self.score = 0.0          # ECC correlation of the last registration (1 = perfect match)

    @staticmethod
    def _normalise(img: np.ndarray, mask: np.ndarray) -> np.ndarray:
        m, sd = cv2.meanStdDev(img, mask=mask)
        return (img - float(m[0, 0])) / max(float(sd[0, 0]), 1e-3)

    def refine(self, gray: np.ndarray, H: np.ndarray) -> np.ndarray | None:
        """Corrected pose (image px → mm) or None if the view does not register on the map.
        `gray` is the working image and H maps its pixels to panel mm."""
        h, w = gray.shape
        corners = cv2.perspectiveTransform(np.float32([[0, 0], [w, 0], [w, h], [0, h]]).reshape(-1, 1, 2), H).reshape(-1, 2)
        x0, y0 = np.maximum(corners.min(axis=0) * self.k, 0).astype(int)
        x1, y1 = np.minimum(corners.max(axis=0) * self.k, (self.w, self.h)).astype(int)
        if x1 - x0 < 40 or y1 - y0 < 40:
            return None  # mostly off the panel: nothing to register against
        # T: panel mm → crop px. Rectify the camera view into the crop's frame.
        T = np.array([[self.k, 0, -x0], [0, self.k, -y0], [0, 0, 1]], np.float64)
        size = (x1 - x0, y1 - y0)
        rect = cv2.warpPerspective(gray, T @ H, size, flags=cv2.INTER_AREA).astype(np.float32)
        valid = cv2.warpPerspective(np.full_like(gray, 255), T @ H, size, flags=cv2.INTER_NEAREST)
        valid = cv2.erode(valid, np.ones((3, 3), np.uint8))
        if cv2.countNonZero(valid) < 0.25 * size[0] * size[1]:
            return None
        crop = self.img[y0:y1, x0:x1]
        # Outliers: where the view and the healthy map disagree a lot (defect, glare, shadow edge).
        # Compared after a 3 mm blur: a defect is a large bright blob and survives it, while a few
        # millimetres of misalignment on the thin busbars (the signal ECC needs) does not.
        blur = lambda im: cv2.GaussianBlur(im, (0, 0), 3.0 * self.k)
        diff = np.abs(self._normalise(blur(rect), valid) - self._normalise(blur(crop), valid))
        outlier = cv2.dilate((diff > 2.0).astype(np.uint8), np.ones((5, 5), np.uint8))
        mask = valid.copy()
        mask[outlier > 0] = 0
        if cv2.countNonZero(mask) < 0.2 * size[0] * size[1]:
            return None
        W = np.eye(3, dtype=np.float32) if self.motion == cv2.MOTION_HOMOGRAPHY else np.eye(2, 3, dtype=np.float32)
        try:
            self.score, W = cv2.findTransformECC(crop, rect, W, self.motion, self.criteria, mask, 3)
        except cv2.error:
            self.score = 0.0
            return None  # did not converge
        if self.score < self.min_score:
            return None
        W3 = W.astype(np.float64) if W.shape[0] == 3 else np.vstack([W, [0, 0, 1]]).astype(np.float64)
        # map(x) ≈ rect(W x): a crop pixel x is seen at rect pixel W x, so H_new = T⁻¹ W⁻¹ T H
        H_new = np.linalg.inv(T) @ np.linalg.inv(W3) @ T @ H
        centre = np.float32([[[w / 2, h / 2]]])
        moved = np.linalg.norm(cv2.perspectiveTransform(centre, H_new) - cv2.perspectiveTransform(centre, H))
        return H_new if moved < self.max_correction else None


class PanelLocalizer:
    def __init__(self, marker_corners_mm, panel_map: PanelMap | None = None, work_width: int = 320,
                 max_points: int = 240, min_points: int = 40, min_inliers: int = 20,
                 max_frames_without_anchor: int = 2000):
        self.marker_mm = np.asarray(marker_corners_mm, np.float32)
        self.map = panel_map
        self.work_width = work_width          # tracking runs on a downscaled grey image
        self.max_points = max_points
        self.min_points = min_points
        self.min_inliers = min_inliers
        self.max_frames = max_frames_without_anchor
        self.lk = dict(winSize=(21, 21), maxLevel=3,
                       criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 20, 0.03))
        self.clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(4, 4))
        self.reset()

    def reset(self) -> None:
        self.H: np.ndarray | None = None      # full-resolution image px → panel mm
        self.prev: np.ndarray | None = None
        self.points: np.ndarray | None = None
        self.step: np.ndarray | None = None   # last frame-to-frame motion (current → previous, working px)
        self.window: np.ndarray | None = None
        self.since_anchor = 0

    def _features(self, gray: np.ndarray) -> np.ndarray | None:
        """Corners spread over a 4 x 3 grid: the quality threshold is relative to the strongest corner,
        so without the grid the high-contrast marker would starve the dark, low-contrast panel."""
        h, w = gray.shape
        per_tile = self.max_points // 12
        found = []
        for gy in range(3):
            for gx in range(4):
                x0, x1, y0, y1 = gx * w // 4, (gx + 1) * w // 4, gy * h // 3, (gy + 1) * h // 3
                pts = cv2.goodFeaturesToTrack(gray[y0:y1, x0:x1], per_tile, qualityLevel=0.02, minDistance=6, blockSize=5)
                if pts is not None:
                    found.append(pts.reshape(-1, 2) + (x0, y0))
        return np.concatenate(found).astype(np.float32).reshape(-1, 1, 2) if found else None

    def _odometry(self, gray: np.ndarray, predict: bool = True) -> tuple[np.ndarray | None, int]:
        """Frame-to-frame homography (current → previous working px) and its RANSAC inliers."""
        if self.prev is None or self.points is None or len(self.points) < self.min_points:
            return None, 0
        if predict and self.step is not None:  # constant velocity: the scene moves as it did last frame
            guess = cv2.perspectiveTransform(self.points, np.linalg.inv(self.step))
        else:  # global shift by phase correlation: robust to large jumps on the repeating busbars
            if self.window is None or self.window.shape != gray.shape:
                self.window = cv2.createHanningWindow(gray.shape[::-1], cv2.CV_32F)
            (dx, dy), _ = cv2.phaseCorrelate(np.float32(self.prev), np.float32(gray), self.window)
            guess = self.points + np.float32([dx, dy])
        flags = cv2.OPTFLOW_USE_INITIAL_FLOW
        nxt, st, _ = cv2.calcOpticalFlowPyrLK(self.prev, gray, self.points, guess.copy(), flags=flags, **self.lk)
        back, st2, _ = cv2.calcOpticalFlowPyrLK(gray, self.prev, nxt, None, **self.lk)
        # forward-backward check: keep points that return to where they started
        good = (st.reshape(-1) == 1) & (st2.reshape(-1) == 1) & \
               (np.linalg.norm((back - self.points).reshape(-1, 2), axis=1) < 1.0)
        a, b = nxt.reshape(-1, 2)[good], self.points.reshape(-1, 2)[good]
        if len(a) < self.min_inliers:
            return None, 0
        H_step, mask = cv2.findHomography(a, b, cv2.RANSAC, 1.5)
        inliers = int(mask.sum()) if mask is not None else 0
        if H_step is None or inliers < self.min_inliers or not self._plausible(H_step, gray.shape):
            return None, inliers
        return H_step, inliers

    def update(self, bgr: np.ndarray, marker_corners_px: np.ndarray | None) -> Pose:
        h, w = bgr.shape[:2]
        s = self.work_width / w
        gray = cv2.cvtColor(cv2.resize(bgr, (self.work_width, round(h * s)), interpolation=cv2.INTER_AREA),
                            cv2.COLOR_BGR2GRAY)
        S = np.diag([s, s, 1.0])          # full-resolution px → working px
        Sinv = np.linalg.inv(S)
        tracked = self.clahe.apply(gray)  # lifts the dark panel's busbars and cell corners
        status, inliers, locked = "lost", 0, False

        H_step, inliers = self._odometry(tracked)
        if H_step is None and self.step is not None:
            H_step, inliers = self._odometry(tracked, predict=False)  # the camera stopped, turned or jumped
        if marker_corners_px is not None:
            A, _ = cv2.estimateAffine2D(np.asarray(marker_corners_px, np.float32).reshape(-1, 2), self.marker_mm,
                                        method=cv2.LMEDS)
            if A is not None:
                self.H, self.since_anchor, status = np.vstack([A, [0, 0, 1]]), 0, "anchored"
        if status != "anchored" and self.H is not None:
            if H_step is None and self.step is not None and self.map is not None:
                H_step = self.step  # odometry failed: predict, and let the map confirm or reject
                predicted = True
            else:
                predicted = False
            if H_step is not None:
                # current working px → previous working px → previous full px → panel mm
                H = self.H @ Sinv @ H_step @ S
                if self.map is not None:
                    refined = self.map.refine(gray, H @ Sinv)
                    if refined is not None:
                        H, locked = refined @ S, True
                if predicted and not locked:
                    self.H = None
                else:
                    self.H, status = H, "tracking"
                    self.since_anchor += 1
            else:
                self.H = None
        if status == "anchored" and self.map is not None:
            refined = self.map.refine(gray, self.H @ Sinv)
            if refined is not None:
                self.H, locked = refined @ S, True

        if self.H is not None and self.since_anchor > self.max_frames:
            self.H, status = None, "lost"  # safety net: never trust a pose forever without the marker

        self.step = H_step if self.H is not None and H_step is not None else None
        self.prev = tracked
        self.points = self._features(tracked) if self.H is not None else None
        return Pose(self.H.copy() if self.H is not None else None, status if self.H is not None else "lost",
                    self.since_anchor, inliers, locked)

    @staticmethod
    def _plausible(H: np.ndarray, shape: tuple[int, int]) -> bool:
        """Reject homographies that are not a small, nearly rigid camera motion between two frames."""
        h, w = shape
        corners = np.float32([[0, 0], [w, 0], [w, h], [0, h]]).reshape(-1, 1, 2)
        moved = cv2.perspectiveTransform(corners, H).reshape(-1, 2)
        shift = np.linalg.norm(moved - corners.reshape(-1, 2), axis=1).max()
        area = cv2.contourArea(moved)
        return shift < 0.35 * w and 0.7 < area / (w * h) < 1.4
