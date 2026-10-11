"""Synthetic YOLO dataset for the HelioScan C14 inspection demo.

Pipeline
--------
1. Render both printed PDFs (6 x A4 sheets each) and stitch them into one panel image
   at a fixed scale (pixels per millimetre), exactly as the sheets are taped together.
2. Ground truth by differencing: |defects - blank| isolates the three printed defects.
   Connected components of the difference mask give pixel-exact bounding boxes, with no
   manual annotation. The class of each box comes from the panel's reference layout.
3. Domain randomisation: each training image is a simulated phone view of the panel
   (random camera footprint, in-plane rotation, perspective tilt, table background,
   black-and-white or colour print, exposure, white balance, blur, sensor noise, JPEG
   compression). Labels are transformed with the same homography as the pixels.
4. Write the dataset in YOLO format (images/, labels/, data.yaml) and the reference
   profile of the panel (defect positions in millimetres, marker id) used on the board.

Usage
-----
    python training/generate_dataset.py --train 300 --val 80
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
from pathlib import Path

import cv2
import pymupdf
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PDF_DIR = ROOT / "print"  # the two printed panels (6 x A4 sheets each)

CLASSES = ["bird_dropping", "crack"]

# Printed layout (millimetres). Each A4 landscape sheet shows a 285 x 198 mm window of
# the panel, offset by a 6 mm white margin; 3 x 2 sheets cover the 855 x 396 mm panel.
SHEET_MM = (285.0, 198.0)
SHEET_MARGIN_MM = 6.0
SHEET_GRID = (3, 2)
PANEL_MM = (SHEET_MM[0] * SHEET_GRID[0], SHEET_MM[1] * SHEET_GRID[1])
FRAME_MM = 11.4  # aluminium frame band (no defect can be there)
SHEET_NAMES = [["A1", "B1", "C1"], ["A2", "B2", "C2"]]

# Reference layout of the C14 demo panel: which defect type is printed on which sheet.
SHEET_DEFECT_CLASS = {"A1": "bird_dropping", "C2": "bird_dropping", "B2": "crack"}

PX_PER_MM = 4.0      # stitching resolution
TABLE_MM = 120.0     # background around the panel in the synthetic scene
OUT_W, OUT_H = 640, 480


# --------------------------------------------------------------------------- rendering

def render_panel(pdf_path: Path, px_per_mm: float = PX_PER_MM) -> np.ndarray:
    """Render the six sheets of a PDF and stitch them into one BGR panel image."""
    doc = pymupdf.open(pdf_path)
    if doc.page_count != SHEET_GRID[0] * SHEET_GRID[1]:
        raise ValueError(f"{pdf_path.name}: expected 6 pages, got {doc.page_count}")
    zoom = px_per_mm * 25.4 / 72.0
    sw, sh = round(SHEET_MM[0] * px_per_mm), round(SHEET_MM[1] * px_per_mm)
    m = round(SHEET_MARGIN_MM * px_per_mm)
    panel = np.zeros((sh * SHEET_GRID[1], sw * SHEET_GRID[0], 3), np.uint8)
    for i, page in enumerate(doc):
        pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
        img = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, pix.n)[:, :, :3]
        col, row = i % SHEET_GRID[0], i // SHEET_GRID[0]
        panel[row * sh:(row + 1) * sh, col * sw:(col + 1) * sw] = img[m:m + sh, m:m + sw]
    return cv2.cvtColor(panel, cv2.COLOR_RGB2BGR)


def sheet_of(x_mm: float, y_mm: float) -> str:
    col = min(SHEET_GRID[0] - 1, max(0, int(x_mm // SHEET_MM[0])))
    row = min(SHEET_GRID[1] - 1, max(0, int(y_mm // SHEET_MM[1])))
    return SHEET_NAMES[row][col]


def extract_defects(defects: np.ndarray, blank: np.ndarray, px_per_mm: float = PX_PER_MM) -> list[dict]:
    """Ground-truth boxes from the difference between the two prints."""
    diff = cv2.absdiff(defects, blank).max(axis=2)
    mask = (diff > 40).astype(np.uint8)
    # Group the pieces of one defect (crack branches, droplets around a dropping)
    radius = round(6 * px_per_mm)
    grouped = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * radius + 1, 2 * radius + 1)))
    n, labels, stats, _ = cv2.connectedComponentsWithStats(grouped)
    frame_px = FRAME_MM * px_per_mm
    h, w = mask.shape
    out = []
    for i in range(1, n):
        ys, xs = np.nonzero((labels == i) & (mask > 0))
        if len(xs) < 50 * px_per_mm:
            continue
        x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        # Sheet labels ("A1 · 1/6 · C14 · blank") differ between the PDFs: they sit in the frame band
        if cx < frame_px or cy < frame_px or cx > w - frame_px or cy > h - frame_px:
            continue
        sheet = sheet_of(cx / px_per_mm, cy / px_per_mm)
        cls = SHEET_DEFECT_CLASS.get(sheet)
        if cls is None:
            raise RuntimeError(f"unexpected difference on sheet {sheet} at ({cx:.0f}, {cy:.0f}) px")
        out.append({
            "class": cls,
            "sheet": sheet,
            "bbox_mm": [round(float(v) / px_per_mm, 1) for v in (x0, y0, x1, y1)],
        })
    out.sort(key=lambda d: (d["bbox_mm"][1] >= SHEET_MM[1], d["bbox_mm"][0]))
    return out


def find_marker(panel: np.ndarray, px_per_mm: float = PX_PER_MM) -> dict:
    """Locate the ArUco start marker (dictionary ARUCO_MIP_36h12) on the rendered panel."""
    gray = cv2.cvtColor(panel, cv2.COLOR_BGR2GRAY)
    detector = cv2.aruco.ArucoDetector(cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_ARUCO_MIP_36h12))
    corners, ids, _ = detector.detectMarkers(gray)
    if ids is None or len(ids) != 1:
        raise RuntimeError(f"expected exactly one ArUco marker, found {0 if ids is None else len(ids)}")
    c = np.asarray(corners[0], np.float32).reshape(-1, 2) / px_per_mm  # OpenCV 4 and 5 shapes
    marker_id = int(np.asarray(ids).reshape(-1)[0])
    return {"dictionary": "DICT_ARUCO_MIP_36h12", "id": marker_id, "corners_mm": [[round(float(x), 1), round(float(y), 1)] for x, y in c]}


# --------------------------------------------------------------------------- synthetic views

def random_background(rng: np.random.Generator, h: int, w: int) -> np.ndarray:
    kind = rng.choice(["paper", "wood", "grey", "dark"], p=[0.35, 0.3, 0.25, 0.1])
    base = {
        "paper": rng.uniform(205, 245, 3),
        "wood": np.array([rng.uniform(60, 110), rng.uniform(100, 150), rng.uniform(140, 200)]),
        "grey": np.full(3, rng.uniform(120, 200)),
        "dark": np.full(3, rng.uniform(50, 90)),
    }[kind]
    bg = np.empty((h, w, 3), np.float32)
    bg[:] = base
    if kind == "wood":
        grain = np.sin(np.linspace(0, rng.uniform(40, 120), w))[None, :, None] * rng.uniform(5, 15)
        bg += grain
    bg += rng.normal(0, 3, (h, w, 1))
    return np.clip(bg, 0, 255).astype(np.uint8)


def prepare_prints(panel: np.ndarray) -> list[dict]:
    """Colour and black-and-white prints of a panel, padded with an empty table border and
    a mask of the paper area, at two resolutions (a coarser one avoids aliasing on wide views).
    Prepared once; each synthetic view only warps the region it needs."""
    pad = round(TABLE_MM * PX_PER_MM)
    gray = cv2.cvtColor(cv2.cvtColor(panel, cv2.COLOR_BGR2GRAY), cv2.COLOR_GRAY2BGR)
    mask = np.zeros(panel.shape[:2], np.uint8)
    mask[:] = 255
    levels = []
    for scale in (1.0, 0.5):
        def pad_scale(img, interp=cv2.INTER_AREA):
            out = cv2.copyMakeBorder(img, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=0)
            return out if scale == 1.0 else cv2.resize(out, None, fx=scale, fy=scale, interpolation=interp)
        levels.append({"scale": scale, "color": pad_scale(panel), "bw": pad_scale(gray), "mask": pad_scale(mask)})
    return levels


def print_tone(img: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Black-and-white printer tone curve (gamma) on a grey image."""
    gamma = rng.uniform(0.8, 1.25)
    return (255.0 * (img.astype(np.float32) / 255.0) ** gamma).astype(np.uint8)


def camera_effects(img: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Phone camera: exposure, white balance, vignetting, blur, noise, JPEG."""
    f = img.astype(np.float32)
    f = f * rng.uniform(0.65, 1.45) + rng.uniform(-20, 20)
    f *= rng.uniform(0.9, 1.1, 3)[None, None, :]
    h, w = f.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    r2 = ((xx - w / 2) / (w / 2)) ** 2 + ((yy - h / 2) / (h / 2)) ** 2
    f *= (1 - rng.uniform(0, 0.35) * r2 / 2)[..., None]
    f = np.clip(f, 0, 255).astype(np.uint8)
    if rng.random() < 0.7:
        f = cv2.GaussianBlur(f, (0, 0), rng.uniform(0.3, 1.6))
    if rng.random() < 0.2:
        k = int(rng.integers(3, 9))
        kernel = np.zeros((k, k), np.float32)
        kernel[k // 2, :] = 1.0 / k
        rot = cv2.getRotationMatrix2D((k / 2, k / 2), float(rng.uniform(0, 180)), 1.0)
        f = cv2.filter2D(f, -1, cv2.warpAffine(kernel, rot, (k, k)))
    noise = rng.normal(0, rng.uniform(2, 9), f.shape)
    f = np.clip(f.astype(np.float32) + noise, 0, 255).astype(np.uint8)
    ok, enc = cv2.imencode(".jpg", f, [cv2.IMWRITE_JPEG_QUALITY, int(rng.integers(45, 92))])
    return cv2.imdecode(enc, cv2.IMREAD_COLOR)


def sample_view(rng: np.random.Generator, defects: list[dict], focus_defects: bool) -> tuple[np.ndarray, float]:
    """Camera footprint on the panel: 4 corners (mm) of the view, clockwise from top-left."""
    width_mm = rng.uniform(170, 470)
    height_mm = width_mm * OUT_H / OUT_W
    if focus_defects and defects:
        d = defects[rng.integers(len(defects))]
        x0, y0, x1, y1 = d["bbox_mm"]
        cx = rng.uniform(x1 - width_mm / 2 + 10, x0 + width_mm / 2 - 10) if x1 - x0 < width_mm - 20 else (x0 + x1) / 2
        cy = rng.uniform(y1 - height_mm / 2 + 10, y0 + height_mm / 2 - 10) if y1 - y0 < height_mm - 20 else (y0 + y1) / 2
    else:
        cx = rng.uniform(-40, PANEL_MM[0] + 40)
        cy = rng.uniform(-40, PANEL_MM[1] + 40)
    angle = math.radians(rng.uniform(-10, 10))
    ca, sa = math.cos(angle), math.sin(angle)
    corners = []
    for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        dx, dy = sx * width_mm / 2, sy * height_mm / 2
        jx, jy = rng.uniform(-0.04, 0.04) * width_mm, rng.uniform(-0.04, 0.04) * height_mm  # perspective tilt
        corners.append((cx + ca * dx - sa * dy + jx, cy + sa * dx + ca * dy + jy))
    return np.array(corners, np.float32), width_mm


def project_boxes(defects: list[dict], H: np.ndarray) -> list[tuple[int, float, float, float, float]]:
    """Defect boxes (mm) → YOLO labels (class, cx, cy, w, h normalised) in the output image."""
    labels = []
    for d in defects:
        x0, y0, x1, y1 = d["bbox_mm"]
        pts = np.array([[[x0, y0]], [[x1, y0]], [[x1, y1]], [[x0, y1]]], np.float32)
        q = cv2.perspectiveTransform(pts, H).reshape(-1, 2)
        bx0, by0 = q.min(axis=0)
        bx1, by1 = q.max(axis=0)
        area = (bx1 - bx0) * (by1 - by0)
        cx0, cy0 = max(bx0, 0), max(by0, 0)
        cx1, cy1 = min(bx1, OUT_W - 1), min(by1, OUT_H - 1)
        if cx1 <= cx0 or cy1 <= cy0:
            continue
        visible = (cx1 - cx0) * (cy1 - cy0) / max(area, 1e-6)
        if visible < 0.5:
            continue  # mostly outside the frame: not labelled
        labels.append((CLASSES.index(d["class"]),
                       (cx0 + cx1) / 2 / OUT_W, (cy0 + cy1) / 2 / OUT_H,
                       (cx1 - cx0) / OUT_W, (cy1 - cy0) / OUT_H))
    return labels


def make_split(name: str, count: int, panels: dict, defects: list[dict], out: Path, seed: int) -> dict:
    rng = np.random.default_rng(seed)
    (out / "images" / name).mkdir(parents=True, exist_ok=True)
    (out / "labels" / name).mkdir(parents=True, exist_ok=True)
    stats = {"images": 0, "boxes": {c: 0 for c in CLASSES}, "negatives": 0}
    dst = np.array([[0, 0], [OUT_W, 0], [OUT_W, OUT_H], [0, OUT_H]], np.float32)
    for i in range(count):
        use_blank = rng.random() < 0.25
        levels = panels["blank" if use_blank else "defects"]
        panel_defects = [] if use_blank else defects
        bw = rng.random() < 0.7
        corners_mm, width_mm = sample_view(rng, defects, focus_defects=rng.random() < 0.7)
        # Coarser level when the view is wide (fewer output pixels per millimetre)
        level = levels[1] if OUT_W / width_mm < 0.5 * PX_PER_MM else levels[0]
        corners_px = (corners_mm + TABLE_MM) * PX_PER_MM * level["scale"]
        Hpx = cv2.getPerspectiveTransform(corners_px.astype(np.float32), dst)
        warp = lambda im: cv2.warpPerspective(im, Hpx, (OUT_W, OUT_H), flags=cv2.INTER_LINEAR, borderValue=0)
        paper = warp(level["bw" if bw else "color"])
        if bw:
            paper = print_tone(paper, rng)
        alpha = warp(level["mask"]).astype(np.float32)[..., None] / 255.0
        img = (paper * alpha + random_background(rng, OUT_H, OUT_W) * (1 - alpha)).astype(np.uint8)
        img = camera_effects(img, rng)
        Hmm = cv2.getPerspectiveTransform(corners_mm.astype(np.float32), dst)
        labels = project_boxes(panel_defects, Hmm)
        stem = f"{name}_{i:04d}"
        cv2.imwrite(str(out / "images" / name / f"{stem}.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 92])
        with open(out / "labels" / name / f"{stem}.txt", "w") as fh:
            for c, x, y, w, h in labels:
                fh.write(f"{c} {x:.6f} {y:.6f} {w:.6f} {h:.6f}\n")
                stats["boxes"][CLASSES[c]] += 1
        stats["images"] += 1
        stats["negatives"] += 0 if labels else 1
    return stats


# --------------------------------------------------------------------------- main

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pdf-dir", type=Path, default=DEFAULT_PDF_DIR)
    ap.add_argument("--out", type=Path, default=ROOT / "training" / "dataset")
    ap.add_argument("--profile", type=Path, default=ROOT / "app" / "python" / "data" / "c14_profile.json")
    ap.add_argument("--train", type=int, default=300)
    ap.add_argument("--val", type=int, default=80)
    ap.add_argument("--seed", type=int, default=14)
    args = ap.parse_args()

    panels = {
        "defects": render_panel(args.pdf_dir / "solar-panel-defects-6xA4.pdf"),
        "blank": render_panel(args.pdf_dir / "solar-panel-blank-6xA4.pdf"),
    }
    defects = extract_defects(panels["defects"], panels["blank"])
    marker = find_marker(panels["defects"])
    prints = {k: prepare_prints(v) for k, v in panels.items()}
    print(f"ground truth: {len(defects)} defects")
    for d in defects:
        print(f"  {d['class']:<14} sheet {d['sheet']}  bbox_mm={d['bbox_mm']}")
    print(f"start marker: {marker['dictionary']} id={marker['id']}")
    if len(defects) != 3:
        raise SystemExit("expected exactly 3 defects in the C14 print, check the PDFs")

    profile = {
        "panel_id": "C14",
        "panel_mm": list(PANEL_MM),
        "sheet_mm": list(SHEET_MM),
        "sheets": SHEET_NAMES,
        "frame_mm": FRAME_MM,
        "marker": marker,
        "defects": defects,
        "classes": CLASSES,
    }
    args.profile.parent.mkdir(parents=True, exist_ok=True)
    args.profile.write_text(json.dumps(profile, indent=2))
    print(f"reference profile -> {args.profile}")

    if args.out.exists():
        shutil.rmtree(args.out)
    s_train = make_split("train", args.train, prints, defects, args.out, args.seed)
    s_val = make_split("val", args.val, prints, defects, args.out, args.seed + 1000)
    (args.out / "data.yaml").write_text(
        f"path: {args.out.as_posix()}\ntrain: images/train\nval: images/val\n"
        f"names:\n" + "".join(f"  {i}: {c}\n" for i, c in enumerate(CLASSES))
    )
    (args.out / "stats.json").write_text(json.dumps({"train": s_train, "val": s_val}, indent=2))
    print(f"train: {s_train}\nval:   {s_val}\ndataset -> {args.out}")


if __name__ == "__main__":
    main()
