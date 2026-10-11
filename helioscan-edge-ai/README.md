# HelioScan Edge — on-device YOLO inspection of solar panels on the Arduino UNO Q

Prototype of a drone inspection payload. A phone acts as the payload camera; every frame is
processed **on the Arduino UNO Q** (edge AI, no cloud): a **YOLO11n object detector** fine-tuned on
the printed C14 panel finds bird droppings and cracks, a **ByteTrack-style multi-object tracker**
turns per-frame detections into physical defects, and a mission state machine reproduces the
drone's **U-shaped coverage path** (start on an ArUco marker, top edge → right edge → bottom edge).
Confirmed defects are checked against the panel's **reference profile** and signalled by the
board's STM32 microcontroller.

```
phone camera ──JPEG over HTTPS/Socket.IO──► UNO Q (Linux, Python)
                                             ├─ panel segmentation (Otsu) + visible edges
                                             ├─ ArUco start marker (OpenCV)
                                             ├─ YOLO11n defect detector (ONNX Runtime)
                                             ├─ multi-object tracking (two-stage association)
                                             └─ inspection mission (U path + reference check)
phone overlay ◄────── results (JSON) ────────┘        └─ Bridge RPC ─► STM32 MCU (LED alerts)
```

## Results

**Detector (validation set, 80 synthetic images never seen in training)**

| Precision | Recall | mAP50 | mAP50-95 | AP50 bird_dropping | AP50 crack |
|---|---|---|---|---|---|
| 0.994 | 1.000 | 0.995 | 0.842 | 0.995 | 0.995 |

Training: 300 synthetic images, 15.8 min on a laptop CPU (Intel Core i5-1335U), YOLO11n at 320 px, transfer learning from COCO weights.

**End-to-end** (`tools/evaluate_pipeline.py`): simulated inspection flights over the rendered
prints, through the exact board pipeline, 7 conditions × 2 prints:

| Condition | Defects print | Blank print |
|---|---|---|
| bw / 25 cm | PASS: 3 found (bird dropping A1, bird dropping C2, crack B2) | PASS: 0 found |
| bw / far (40 cm) | PASS: 3 found (bird dropping A1, bird dropping C2, crack B2) | PASS: 0 found |
| bw / close (18 cm) | PASS: 3 found (bird dropping A1, bird dropping C2, crack B2) | PASS: 0 found |
| bw / dim + blur | PASS: 3 found (bird dropping A1, bird dropping C2, crack B2) | PASS: 0 found |
| bw / bright + noise | PASS: 3 found (bird dropping A1, bird dropping C2, crack B2) | PASS: 0 found |
| bw / wood table | PASS: 3 found (bird dropping A1, bird dropping C2, crack B2) | PASS: 0 found |
| colour / 25 cm | PASS: 3 found (bird dropping A1, bird dropping C2, crack B2) | PASS: 0 found |

**14/14 flights passed.** Every flight completed the U path on its own (marker start, corners detected). Mean YOLO inference on the laptop CPU: 24 ms per frame; on the UNO Q the time is displayed live on the phone.

## Repository

| Path | Content |
|---|---|
| [`app/`](app) | **The Arduino App Lab application** (copy/import to the UNO Q) |
| [`app/python/main.py`](app/python/main.py) | Entry point: WebUI brick (HTTPS), message handlers, Bridge to the MCU |
| [`app/python/helioscan/`](app/python/helioscan) | Pipeline: `detector.py` (YOLO/ONNX), `geometry.py` (panel, edges, ArUco), `tracker.py`, `mission.py`, `pipeline.py`, `service.py` |
| [`app/python/models/`](app/python/models) | Trained model `helioscan_yolo11n.onnx` + `model_card.json` (metrics) |
| [`app/python/data/c14_profile.json`](app/python/data/c14_profile.json) | Reference profile of the printed panel (defects in mm, marker id) |
| [`app/sketch/sketch.ino`](app/sketch/sketch.ino) | STM32 sketch: `scan_state` / `defect_alert` over the Bridge |
| [`app/assets/`](app/assets) | Phone web page (camera, frame streaming, overlay) |
| [`print/`](print) | The two printed panels (6 × A4 sheets each): `solar-panel-defects-6xA4.pdf` (3 defects) and `solar-panel-blank-6xA4.pdf` (healthy) |
| [`training/`](training) | `generate_dataset.py` (synthetic dataset from the PDFs), `train.py` (YOLO training + ONNX export), training curves in `runs/c14/` |
| [`tools/`](tools) | `evaluate_pipeline.py` (end-to-end test), `dev_server.py` (run everything on a computer), `package_app.py` (App Lab ZIP) |
| [`docs/`](docs) | [Architecture](docs/ARCHITECTURE.md) · [Training](docs/TRAINING.md) · [Deployment](docs/DEPLOYMENT.md) · [Scaling to real farms](docs/SCALING.md) |

## Quick start

**On the UNO Q** (details in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)):

1. `python tools/package_app.py` → `dist/helioscan-edge.zip`
2. Import the ZIP in Arduino App Lab, press **Run** (first run installs NumPy, OpenCV, ONNX Runtime).
3. On the phone (same Wi-Fi): `https://<board-ip>:7000`, accept the certificate, **Start camera**.

**On a computer** (same page, same pipeline, no board):

```bash
pip install -r tools/requirements-dev.txt
python tools/dev_server.py        # then open https://<computer-ip>:7000 on the phone
```

**Retrain the model** (about 15 minutes on a laptop CPU):

```bash
pip install --index-url https://download.pytorch.org/whl/cpu torch torchvision
pip install -r training/requirements.txt
python training/generate_dataset.py --train 300 --val 80
python training/train.py --minutes 15
```

## Scope

- The detector is trained on synthetic views rendered from the two print files (domain
  randomisation: distance, tilt, black-and-white or colour print, lighting, blur, noise, JPEG).
  It is specific to this printed panel; [docs/SCALING.md](docs/SCALING.md) explains the path to real
  panels (real labelled imagery, thermal channel, georeferencing).
- Scores above are measured on synthetic images and simulated flights. Run time on the UNO Q is
  shown live on the phone (YOLO time and frame rate).

Model: Ultralytics YOLO11 (AGPL-3.0). Socket.IO client: MIT.
