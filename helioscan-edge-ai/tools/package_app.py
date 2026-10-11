"""Package the UNO Q application as a ZIP that Arduino App Lab can import.

App Lab expects app.yaml at the root of the archive or inside a single top-level folder;
the archive produced here is:  helioscan-edge/app.yaml, python/, sketch/, assets/

Usage
-----
    python tools/package_app.py          → dist/helioscan-edge.zip
"""

from __future__ import annotations

import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app"
OUT = ROOT / "dist" / "helioscan-edge.zip"
SKIP_DIRS = {"__pycache__", ".pytest_cache"}
REQUIRED = ["app.yaml", "python/main.py", "python/requirements.txt", "python/models/helioscan_yolo11n.onnx",
            "python/models/model_card.json", "python/data/c14_profile.json", "sketch/sketch.ino", "assets/index.html"]


def main() -> None:
    missing = [p for p in REQUIRED if not (APP / p).exists()]
    if missing:
        raise SystemExit(f"missing files (train the model first?): {missing}")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(APP.rglob("*")):
            if f.is_dir() or SKIP_DIRS.intersection(f.relative_to(APP).parts):
                continue
            z.write(f, Path("helioscan-edge") / f.relative_to(APP))
            count += 1
    print(f"{count} files -> {OUT} ({OUT.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
