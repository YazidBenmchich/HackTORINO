"""End-to-end evaluation of the board pipeline on simulated inspection flights.

For each condition, a virtual phone flies the drone's U-shaped path over the rendered C14
panel (defects print and blank print): start on the marker, right along the top edge, down
the right edge, left along the bottom edge. Every frame goes through the exact pipeline that
runs on the UNO Q (panel, ArUco, YOLO, tracking, mission).

Pass criteria
    defects print → exactly 3 findings: bird dropping A1, crack B2, bird dropping C2
    blank print   → 0 findings
    both          → the path reaches DONE by itself (corners detected, no manual skip)

Usage
-----
    python tools/evaluate_pipeline.py
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app" / "python"))
sys.path.insert(0, str(ROOT / "training"))

from generate_dataset import DEFAULT_PDF_DIR, PANEL_MM, PX_PER_MM, render_panel  # noqa: E402
from helioscan.pipeline import InspectionPipeline  # noqa: E402

OUT_W, OUT_H = 640, 480
TABLE_MM = 120.0

CONDITIONS = {
    "bw / 25 cm":           dict(print_mode="bw", view_mm=300, edge_mm=35),
    "bw / far (40 cm)":     dict(print_mode="bw", view_mm=420, edge_mm=45),
    "bw / close (18 cm)":   dict(print_mode="bw", view_mm=230, edge_mm=25),
    "bw / dim + blur":      dict(print_mode="bw", view_mm=300, edge_mm=35, gain=0.6, blur=1.6),
    "bw / bright + noise":  dict(print_mode="bw", view_mm=300, edge_mm=35, gain=1.4, noise=10),
    "bw / wood table":      dict(print_mode="bw", view_mm=300, edge_mm=35, table=(70, 110, 160)),
    "colour / 25 cm":       dict(print_mode="color", view_mm=300, edge_mm=35),
}
EXPECTED = {("bird_dropping", "A1"), ("crack", "B2"), ("bird_dropping", "C2")}


def scene_for(panel: np.ndarray, print_mode: str, table) -> np.ndarray:
    img = panel
    if print_mode == "bw":
        img = cv2.cvtColor(cv2.cvtColor(panel, cv2.COLOR_BGR2GRAY), cv2.COLOR_GRAY2BGR)
    pad = round(TABLE_MM * PX_PER_MM)
    scene = np.empty((img.shape[0] + 2 * pad, img.shape[1] + 2 * pad, 3), np.uint8)
    scene[:] = table
    scene[pad:pad + img.shape[0], pad:pad + img.shape[1]] = img
    return scene


def flight(view_w: float, edge: float, fps: float = 4.0, speed: float = 60.0):
    """Camera positions (top-left of the footprint, mm) along the U path."""
    view_h = view_w * OUT_H / OUT_W
    xl, yt = -edge, -edge
    xr, yb = PANEL_MM[0] + edge - view_w, PANEL_MM[1] + edge - view_h
    path = []

    def hold(x, y, s):
        path.extend([(x, y)] * int(s * fps))

    def move(x0, y0, x1, y1):
        n = max(1, int(np.hypot(x1 - x0, y1 - y0) / speed * fps))
        path.extend([(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n) for i in range(1, n + 1)])

    hold(xl, yt, 1.5); move(xl, yt, xr, yt); hold(xr, yt, 1.5)
    move(xr, yt, xr, yb); hold(xr, yb, 1.5); move(xr, yb, xl, yb); hold(xl, yb, 2.0)
    return path, view_h, fps


def render_view(scene, x, y, w, h, rng, gain=1.0, blur=0.8, noise=4.0, jitter=4.0):
    jx, jy = rng.normal(0, jitter, 2)
    src = np.array([[x + jx, y + jy], [x + jx + w, y + jy], [x + jx + w, y + jy + h], [x + jx, y + jy + h]], np.float32)
    src = (src + TABLE_MM) * PX_PER_MM
    dst = np.array([[0, 0], [OUT_W, 0], [OUT_W, OUT_H], [0, OUT_H]], np.float32)
    img = cv2.warpPerspective(scene, cv2.getPerspectiveTransform(src, dst), (OUT_W, OUT_H), flags=cv2.INTER_AREA)
    img = cv2.GaussianBlur(img, (0, 0), blur)
    img = np.clip(img.astype(np.float32) * gain + rng.normal(0, noise, img.shape), 0, 255).astype(np.uint8)
    ok, enc = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 72])  # same JPEG quality as the phone
    return cv2.imdecode(enc, cv2.IMREAD_COLOR)


def run(pipeline, panel, cond, rng):
    pipeline.reset()
    pipeline.configure(print_mode=cond["print_mode"])
    scene = scene_for(panel, cond["print_mode"], cond.get("table", (225, 225, 220)))
    path, view_h, fps = flight(cond["view_mm"], cond["edge_mm"])
    steps, yolo_ms, total_ms = [], [], []
    res = None
    for i, (x, y) in enumerate(path):
        img = render_view(scene, x, y, cond["view_mm"], view_h, rng, cond.get("gain", 1.0), cond.get("blur", 0.8),
                          cond.get("noise", 4.0))
        res = pipeline.process(img, t=i / fps)
        yolo_ms.append(res["timings"]["yolo_ms"])
        total_ms.append(res["timings"]["total_ms"])
        steps += [e["step"] for e in res["events"] if e["type"] == "step"]
        if res["done"]:
            break
    found = {(f["type"], f["sheet"]) for f in res["findings"]}
    return {
        "done": res["done"], "steps": steps, "findings": res["findings"], "found": found,
        "frames": len(yolo_ms), "yolo_ms": float(np.mean(yolo_ms)), "total_ms": float(np.mean(total_ms)),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model-dir", type=Path, default=ROOT / "app" / "python" / "models")
    ap.add_argument("--out", type=Path, default=ROOT / "tools" / "evaluation_results.json")
    args = ap.parse_args()
    t0 = time.time()
    panels = {
        "defects": render_panel(DEFAULT_PDF_DIR / "solar-panel-defects-6xA4.pdf"),
        "blank": render_panel(DEFAULT_PDF_DIR / "solar-panel-blank-6xA4.pdf"),
    }
    pipeline = InspectionPipeline(model_dir=args.model_dir)
    rng = np.random.default_rng(7)
    rows, passed = [], 0
    for name, cond in CONDITIONS.items():
        for kind in ("defects", "blank"):
            r = run(pipeline, panels[kind], cond, rng)
            ok = r["done"] and (r["found"] == EXPECTED if kind == "defects" else not r["found"])
            ok = ok and len(r["findings"]) == (3 if kind == "defects" else 0)
            passed += ok
            found = ", ".join(f"{f['label']} {f['sheet']} ({f['confidence']:.2f})" for f in r["findings"]) or "none"
            print(f"{'PASS' if ok else 'FAIL'}  {name:<22} {kind:<8} path={'complete' if r['done'] else 'INCOMPLETE'}"
                  f"  findings={len(r['findings'])} [{found}]  frames={r['frames']}  yolo={r['yolo_ms']:.0f} ms  total={r['total_ms']:.0f} ms")
            rows.append({"condition": name, "panel": kind, "pass": bool(ok), "path_complete": r["done"],
                         "findings": r["findings"], "frames": r["frames"],
                         "mean_yolo_ms": round(r["yolo_ms"], 1), "mean_pipeline_ms": round(r["total_ms"], 1)})
    total = len(rows)
    print(f"\n{passed}/{total} flights passed  ({time.time() - t0:.0f} s)")
    out = args.out
    out.write_text(json.dumps({"passed": passed, "total": total, "flights": rows}, indent=2))
    print(f"details -> {out}")


if __name__ == "__main__":
    main()
