"""End-to-end evaluation of the board pipeline on simulated inspection flights.

A virtual phone flies the drone's U-shaped path over a rendered panel: start on the marker,
right along the top edge, down the right edge, left along the bottom edge. Every frame goes
through the exact pipeline that runs on the UNO Q (panel, ArUco, pose, YOLO, tracking, mission).
The true camera pose of every frame is known, so the evaluation measures more than pass/fail:

    detection   defects found / missed / unexpected, class correct, solar cell correct
    position    distance between each reported defect and its true centre (mm)
    pose        drift of the estimated camera pose, % of frames localised

Panels
    printed     the C14 demo print (3 defects): held out, the detector never trained on it
    blank       the healthy print: any finding is a false alarm
    procedural  new random panels (seeds never used for the dataset): defects nobody placed by hand

Pass criteria per flight
    path complete; printed → exactly its defects, correct class and cell; blank → no finding;
    procedural → reported in the summary (recall, precision, cell accuracy), not pass/fail

Usage
-----
    python tools/evaluate_pipeline.py                 # all flights
    python tools/evaluate_pipeline.py --quick         # printed + blank, 3 conditions
"""

from __future__ import annotations

import argparse
import copy
import json
import math
import sys
import time
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app" / "python"))
sys.path.insert(0, str(ROOT / "training"))

from defects import synth_panel  # noqa: E402
from generate_dataset import DEFAULT_PDF_DIR, GLASS_MM, PANEL_MM, PX_PER_MM, render_panel  # noqa: E402
from helioscan.pipeline import InspectionPipeline  # noqa: E402

OUT_W, OUT_H = 640, 480
TABLE_MM = 120.0

# view_mm: footprint width (camera height); wobble: hand-held rotation (deg) and height (fraction)
CONDITIONS = {
    "bw / 25 cm":            dict(print_mode="bw", view_mm=300),
    "bw / far (40 cm)":      dict(print_mode="bw", view_mm=420),
    "bw / close (18 cm)":    dict(print_mode="bw", view_mm=230),
    "bw / dim + blur":       dict(print_mode="bw", view_mm=300, gain=0.6, blur=1.6),
    "bw / bright + noise":   dict(print_mode="bw", view_mm=300, gain=1.4, noise=10),
    "bw / wood table":       dict(print_mode="bw", view_mm=300, table=(70, 110, 160)),
    "bw / hand-held wobble": dict(print_mode="bw", view_mm=300, rot=6.0, height=0.12, tilt=0.04),
    "bw / fast (10 cm/s)":   dict(print_mode="bw", view_mm=300, speed=100.0),
    "colour / 25 cm":        dict(print_mode="color", view_mm=300),
    "colour / wobble":       dict(print_mode="color", view_mm=300, rot=6.0, height=0.12, tilt=0.04),
}
QUICK = ["bw / 25 cm", "bw / hand-held wobble", "colour / 25 cm"]
PROCEDURAL_CONDITIONS = ["bw / 25 cm", "bw / hand-held wobble", "colour / 25 cm"]


def scene_for(panel: np.ndarray, print_mode: str, table) -> np.ndarray:
    img = panel
    if print_mode == "bw":
        img = cv2.cvtColor(cv2.cvtColor(panel, cv2.COLOR_BGR2GRAY), cv2.COLOR_GRAY2BGR)
    pad = round(TABLE_MM * PX_PER_MM)
    scene = np.empty((img.shape[0] + 2 * pad, img.shape[1] + 2 * pad, 3), np.uint8)
    scene[:] = table
    scene[pad:pad + img.shape[0], pad:pad + img.shape[1]] = img
    return scene


def flight(view_w: float, fps: float = 4.0, speed: float = 60.0, margin: float = 35.0):
    """Centre of the camera footprint (mm) along the U path, and time."""
    view_h = view_w * OUT_H / OUT_W
    xl, yt = view_w / 2 - margin, view_h / 2 - margin
    xr, yb = PANEL_MM[0] + margin - view_w / 2, PANEL_MM[1] + margin - view_h / 2
    path = []

    def hold(x, y, s):
        path.extend([(x, y)] * int(s * fps))

    def move(x0, y0, x1, y1):
        n = max(1, int(np.hypot(x1 - x0, y1 - y0) / speed * fps))
        path.extend([(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n) for i in range(1, n + 1)])

    hold(xl, yt, 1.5); move(xl, yt, xr, yt); hold(xr, yt, 1.5)
    move(xr, yt, xr, yb); hold(xr, yb, 1.5); move(xr, yb, xl, yb); hold(xl, yb, 2.0)
    return path, fps


def footprint(cx: float, cy: float, view_w: float, i: int, fps: float, rng, rot=0.0, height=0.0, tilt=0.0):
    """Four corners (mm) of the camera footprint, with hand-held rotation, height change and tilt."""
    t = i / fps
    a = math.radians(rot * math.sin(2 * math.pi * 0.23 * t + 0.7))
    s = 1.0 + height * math.sin(2 * math.pi * 0.17 * t)
    w, h = view_w * s, view_w * s * OUT_H / OUT_W
    cx, cy = cx + rng.normal(0, 3), cy + rng.normal(0, 3)
    ca, sa = math.cos(a), math.sin(a)
    out = []
    for k, (sx, sy) in enumerate(((-1, -1), (1, -1), (1, 1), (-1, 1))):
        dx, dy = sx * w / 2, sy * h / 2
        # tilt: one side of the footprint wider than the other (camera not parallel to the panel)
        g = 1.0 + tilt * math.sin(2 * math.pi * 0.11 * t) * sy
        out.append((cx + (ca * dx - sa * dy) * g, cy + (sa * dx + ca * dy) * g))
    return np.array(out, np.float32)


def render_view(scene, corners_mm, rng, gain=1.0, blur=0.8, noise=4.0):
    dst = np.array([[0, 0], [OUT_W, 0], [OUT_W, OUT_H], [0, OUT_H]], np.float32)
    src = (corners_mm + TABLE_MM) * PX_PER_MM
    img = cv2.warpPerspective(scene, cv2.getPerspectiveTransform(src, dst), (OUT_W, OUT_H), flags=cv2.INTER_AREA)
    img = cv2.GaussianBlur(img, (0, 0), blur)
    img = np.clip(img.astype(np.float32) * gain + rng.normal(0, noise, img.shape), 0, 255).astype(np.uint8)
    ok, enc = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 72])  # same JPEG quality as the phone
    return cv2.imdecode(enc, cv2.IMREAD_COLOR), cv2.getPerspectiveTransform(dst, corners_mm)


def run(pipeline: InspectionPipeline, panel: np.ndarray, truth: list[dict], cond: dict, rng) -> dict:
    pipeline.mission.profile = dict(pipeline.mission.profile, defects=truth)
    pipeline.reset()
    pipeline.configure(print_mode=cond["print_mode"])
    scene = scene_for(panel, cond["print_mode"], cond.get("table", (225, 225, 220)))
    path, fps = flight(cond["view_mm"], speed=cond.get("speed", 60.0))
    yolo_ms, total_ms, pose_err, localised = [], [], [], 0
    res = None
    centre = np.array([[OUT_W / 2, OUT_H / 2]], np.float32).reshape(-1, 1, 2)
    for i, (x, y) in enumerate(path):
        corners = footprint(x, y, cond["view_mm"], i, fps, rng, cond.get("rot", 0.0), cond.get("height", 0.0),
                            cond.get("tilt", 0.0))
        img, H_true = render_view(scene, corners, rng, cond.get("gain", 1.0), cond.get("blur", 0.8), cond.get("noise", 4.0))
        res = pipeline.process(img, t=i / fps)
        yolo_ms.append(res["timings"]["yolo_ms"])
        total_ms.append(res["timings"]["total_ms"])
        H_est = pipeline.localizer.H
        if H_est is not None:
            localised += 1
            p_true = cv2.perspectiveTransform(centre, H_true).reshape(2)
            p_est = cv2.perspectiveTransform(centre, H_est).reshape(2)
            pose_err.append(float(np.hypot(*(p_true - p_est))))
        if res["done"]:
            break
    report = pipeline.report()
    return {
        "done": res["done"], "report": report, "frames": len(yolo_ms),
        "yolo_ms": float(np.mean(yolo_ms)), "total_ms": float(np.mean(total_ms)),
        "localised": localised / len(yolo_ms),
        "pose_err_mean": float(np.mean(pose_err)) if pose_err else None,
        "pose_err_max": float(np.max(pose_err)) if pose_err else None,
    }


def procedural_panels(blank: np.ndarray, marker_corners, n: int, seed: int):
    mx = [c[0] for c in marker_corners]
    my = [c[1] for c in marker_corners]
    keep_out = [(min(mx) - 6, min(my) - 6, max(mx) + 6, max(my) + 6)]
    rng = np.random.default_rng(seed)
    for k in range(n):
        img, defects = synth_panel(blank, rng, PX_PER_MM, GLASS_MM, keep_out, count=int(rng.integers(2, 6)))
        yield f"procedural #{k + 1}", img, [dict(d, sheet="") for d in defects]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model-dir", type=Path, default=ROOT / "app" / "python" / "models")
    ap.add_argument("--model-file", default=None, help="ONNX file in the model dir (default: the card's deploy model)")
    ap.add_argument("--procedural", type=int, default=6, help="random panels to fly (0 to skip)")
    ap.add_argument("--quick", action="store_true", help="printed + blank panels, 3 conditions")
    ap.add_argument("--out", type=Path, default=ROOT / "tools" / "evaluation_results.json")
    args = ap.parse_args()
    t0 = time.time()
    pipeline = InspectionPipeline(model_dir=args.model_dir, model_file=args.model_file)
    reference = copy.deepcopy(pipeline.profile["defects"])
    panels = {
        "printed": render_panel(DEFAULT_PDF_DIR / "solar-panel-defects-6xA4.pdf"),
        "blank": render_panel(DEFAULT_PDF_DIR / "solar-panel-blank-6xA4.pdf"),
    }
    names = QUICK if args.quick else list(CONDITIONS)
    rng = np.random.default_rng(7)
    rows, passed, total = [], 0, 0
    print(f"model: {pipeline.model_file}")

    def line(name, kind, r, verdict):
        f = r["report"]["findings"]
        found = ", ".join(f"{x['label']} {x['cell']} ({x['confidence']:.2f})" for x in f) or "none"
        drift = f"{r['pose_err_mean']:.1f}/{r['pose_err_max']:.1f} mm" if r["pose_err_mean"] is not None else "n/a"
        print(f"{verdict:<5} {name:<22} {kind:<14} path={'ok' if r['done'] else 'INCOMPLETE'}  "
              f"[{found}]  pose err mean/max={drift}  localised={r['localised']:.0%}  yolo={r['yolo_ms']:.0f} ms")

    for name in names:
        cond = CONDITIONS[name]
        for kind, truth in (("printed", reference), ("blank", [])):
            r = run(pipeline, panels[kind], truth, cond, rng)
            g = r["report"]["reference_check"]
            if kind == "printed":
                ok = r["done"] and len(g["matched"]) == 3 and not g["missed"] and not g["unexpected"] \
                    and all(m["type_ok"] for m in g["matched"])
            else:
                ok = r["done"] and not r["report"]["findings"]
            passed += ok
            total += 1
            line(name, kind, r, "PASS" if ok else "FAIL")
            rows.append({"condition": name, "panel": kind, "pass": bool(ok), **{k: v for k, v in r.items() if k != "report"},
                         "findings": r["report"]["findings"], "reference_check": g, "coverage": r["report"]["coverage"]})

    proc = {"defects": 0, "matched": 0, "type_ok": 0, "cell_ok": 0, "unexpected": 0, "errors": []}
    if not args.quick and args.procedural:
        for pname, img, truth in procedural_panels(panels["blank"], pipeline.profile["marker"]["corners_mm"],
                                                   args.procedural, seed=90210):
            for name in PROCEDURAL_CONDITIONS:
                r = run(pipeline, img, truth, CONDITIONS[name], rng)
                g = r["report"]["reference_check"]
                cells = {f["number"]: f["cell"] for f in r["report"]["findings"]}
                proc["defects"] += len(truth)
                proc["matched"] += len(g["matched"])
                proc["type_ok"] += sum(m["type_ok"] for m in g["matched"])
                proc["cell_ok"] += sum(cells[m["number"]] == m["cell"] for m in g["matched"])
                proc["unexpected"] += len(g["unexpected"])
                proc["errors"] += [m["error_mm"] for m in g["matched"]]
                verdict = f"{len(g['matched'])}/{len(truth)}"
                line(name, pname, r, verdict)
                rows.append({"condition": name, "panel": pname, **{k: v for k, v in r.items() if k != "report"},
                             "truth": truth, "findings": r["report"]["findings"], "reference_check": g})

    print(f"\nprinted + blank: {passed}/{total} flights passed")
    summary = {"passed": passed, "total": total}
    if proc["defects"]:
        found = proc["matched"] + proc["unexpected"]
        summary["procedural"] = {
            "flights": args.procedural * len(PROCEDURAL_CONDITIONS),
            "defects": proc["defects"],
            "recall": round(proc["matched"] / proc["defects"], 3),
            "precision": round(proc["matched"] / found, 3) if found else None,
            "class_accuracy": round(proc["type_ok"] / max(1, proc["matched"]), 3),
            "cell_accuracy": round(proc["cell_ok"] / max(1, proc["matched"]), 3),
            "position_error_mm": {"mean": round(float(np.mean(proc["errors"])), 1),
                                  "p95": round(float(np.percentile(proc["errors"], 95)), 1)} if proc["errors"] else None,
        }
        p = summary["procedural"]
        print(f"procedural panels: recall {p['recall']:.0%}  precision {p['precision']:.0%}  class {p['class_accuracy']:.0%}"
              f"  cell {p['cell_accuracy']:.0%}  position error mean {p['position_error_mm']['mean']} mm"
              f" (p95 {p['position_error_mm']['p95']} mm)  over {p['defects']} defects")
    errs = [r["pose_err_mean"] for r in rows if r["pose_err_mean"] is not None]
    summary["pose_error_mm_mean"] = round(float(np.mean(errs)), 1) if errs else None
    summary["mean_yolo_ms"] = round(float(np.mean([r["yolo_ms"] for r in rows])), 1)
    summary["mean_pipeline_ms"] = round(float(np.mean([r["total_ms"] for r in rows])), 1)
    print(f"mean pose error {summary['pose_error_mm_mean']} mm   YOLO {summary['mean_yolo_ms']} ms   "
          f"pipeline {summary['mean_pipeline_ms']} ms   ({time.time() - t0:.0f} s)")
    if not args.quick:
        args.out.write_text(json.dumps({"model": pipeline.model_file, "summary": summary, "flights": rows}, indent=2))
        print(f"details -> {args.out}")
    sys.exit(0 if passed == total else 1)


if __name__ == "__main__":
    main()
