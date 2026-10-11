# Architecture

HelioScan Edge splits the work the way a drone payload would: a lightweight **sensor head** (here the
phone camera) and an **edge computer** that runs all the perception on board (the Arduino UNO Q).
Nothing is sent to the cloud.

```
 ┌──────────────── Phone (camera + display) ───────────────┐
 │ getUserMedia → crop to what is on screen → JPEG 640 px  │
 │ overlay: boxes, path, alerts  ◄──────────────┐          │
 └──────────────┬───────────────────────────────┼──────────┘
                │ Socket.IO over HTTPS (Wi-Fi)  │ frame_response (JSON)
 ┌──────────────▼───────────────────────────────┴──────────┐
 │ Arduino UNO Q — Linux side (Qualcomm QRB2210, Python)    │
 │                                                          │
 │  decode ─► panel segmentation ─► ArUco ─► YOLO11n (ONNX) │
 │                │ visible edges     │ start    │ boxes     │
 │                ▼                   ▼          ▼           │
 │            mission FSM ◄──── multi-object tracker         │
 │            (U path +        (ByteTrack-style)             │
 │             reference profile)                            │
 │                │ events                                   │
 └────────────────┼─────────────────────────────────────────┘
                  │ Bridge (RPC)
 ┌────────────────▼──────────────── STM32U585 MCU ──────────┐
 │ scan_state / defect_alert → LED status patterns          │
 └──────────────────────────────────────────────────────────┘
```

## 1. Frame transport (`app/assets/app.js`, `python/main.py`)

- The page is served by the Arduino **WebUI brick** with TLS (`WebUI(use_tls=True)`): phone browsers
  only grant camera access to secure pages.
- The phone sends only the part of the camera image that is visible on screen, resized to 640 px on
  the long side and JPEG-encoded (quality 0.72, about 40 kB).
- **Stop-and-wait flow control**: a new frame is sent only when the answer to the previous one has
  arrived. The stream automatically matches the board's processing rate, with no queue and no growing
  latency.
- The WebUI brick runs each message handler in a worker thread, so inference never blocks the
  server; a lock serialises frames through the pipeline.

## 2. Panel segmentation and visible edges (`helioscan/geometry.py`)

- **Black-and-white print**: the panel is the dark part of the image. The dark/light threshold is
  computed for every frame with **Otsu's method** (maximises the between-class variance of the
  histogram), so it follows the phone's auto-exposure.
- **Colour print**: the panel is the blue part (cell colour rule).
- The mask is evaluated on a 64-column block grid; enclosed light areas (defects, marker) are filled
  with a flood fill from the border, so they count as panel.
- A band outside the panel along one side of the image (≥ 4 % of the image) means that **edge of
  the panel is in view**. The inspection path uses it to detect corners.

## 3. Start marker (`helioscan/geometry.py`)

- OpenCV **ArUco** detector, dictionary `DICT_ARUCO_MIP_36h12`, sub-pixel corner refinement.
- The marker id (100) is read from the panel's reference profile, so other markers are ignored.
- The marker anchors the start of the inspection, and the mission keeps its position in memory
  so that nothing on the marker can ever be counted as a defect.

## 4. Defect detection: YOLO (`helioscan/detector.py`)

- Model: **YOLO11n** (Ultralytics), fine-tuned on the C14 synthetic dataset, exported to **ONNX**
  and executed with **ONNX Runtime** on the UNO Q's Cortex-A53 cores (4 threads).
- Pre-processing: letterbox resize to 320 × 320 (aspect ratio kept, grey padding), RGB, 0..1.
- Post-processing: decode the anchor-free head (centre, size, one score per class), confidence
  threshold, **class-aware non-maximum suppression**, boxes mapped back to the frame.
- Two thresholds: detections above the user threshold (default 0.35) can create tracks; weaker
  ones (≥ 0.15) can only extend an existing track (see tracking).

Classes: `bird_dropping`, `crack`. See [TRAINING.md](TRAINING.md) for the dataset and metrics.

## 5. Multi-object tracking (`helioscan/tracker.py`)

Detections are per frame; an inspection needs **objects**. The tracker turns detections into
persistent defects, following the ByteTrack association scheme:

1. **Stage 1**: high-confidence detections are matched to live tracks by centre distance (gated
   at 22 % of the image diagonal) with an IoU bonus, greedy on increasing cost.
2. **Stage 2**: tracks still unmatched may be extended by low-confidence detections that overlap
   them. A defect stays tracked when its score dips for a few frames (motion blur, glare).
3. **Births**: an unmatched high-confidence detection that touches a live track is absorbed by
   it (pieces of one crack seen from far away). Otherwise it starts a new track.
4. A track is **confirmed** after 3 hits over at least 0.3 s. Its class is the confidence-weighted
   vote over its history.

## 6. Inspection mission (`helioscan/mission.py`)

**Coverage path**: a finite-state machine reproduces the drone's U-shaped pass.

| State | Phone motion | Leaves the state when |
|---|---|---|
| `marker` | aim at the ArUco marker (top-left) | marker seen for 0.5 s |
| `right` | along the top edge | right edge visible for 0.5 s (top-right corner) |
| `down` | along the right edge | bottom edge visible for 0.5 s (bottom-right corner) |
| `left` | along the bottom edge | left edge visible for 0.5 s (bottom-left corner) |
| `done` | — | — |

An arrival edge only counts after it has been out of view for 0.6 s, which prevents an immediate
turn when the whole panel is in view.

**Reference-based verification**: industrial inspection compares the observed part with a
reference ("golden sample"). Here the reference is the panel's **digital profile**
(`python/data/c14_profile.json`), computed from the PDFs by `training/generate_dataset.py`: panel
size, sheet grid, marker id and the position of every printed defect, in millimetres.

- The rows of sheets (top row A1–C1, bottom row A2–C2) each have a list of expected defects.
- A confirmed track is counted only if it fills a free slot of the row being inspected. The slot
  gives the finding its sheet (A1, B2, C2).
- Anything else (a second piece of an already counted crack, a reflection) is **rejected for this
  row only** and re-examined when the path reaches the next row. A defect of the bottom row seen
  early, from far away during the top pass, is therefore still counted on the bottom row.
- On the blank panel nothing is detected, so nothing is counted: the reference never creates a
  finding by itself.

## 7. Microcontroller (`app/sketch/sketch.ino`)

The STM32U585 exposes two RPC functions through the Arduino **Bridge** (`Arduino_RouterBridge`):

- `scan_state(state)`: 0 idle (LED off), 1 inspecting (heartbeat), 2 complete (solid on).
- `defect_alert(n)`: n quick flashes for defect number n.

The LED pattern runs in `loop()` without blocking, so Bridge calls return immediately. Python calls
the MCU from a separate thread, so a slow or missing sketch never delays the vision pipeline.

## 8. Latency budget

Each result carries the time spent in every stage (`timings`: panel, marker, YOLO, tracking). The
phone shows the YOLO time and the end-to-end frame rate in the status pill. Measured values are in
the README.
