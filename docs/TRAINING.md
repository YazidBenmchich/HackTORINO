# Training the YOLO defect detector

## The problem with the first version

The hackathon model was trained on views of the printed panel, so the three defects it was tested
on were the same three it had trained on. A good score could not separate "learned what a crack
looks like" from "recognised this crack". The dataset was rebuilt after the event to fix that:

| Split | Content | Used for |
|---|---|---|
| train | blank print + procedural defects (seed 14) | training |
| val | blank print + new procedural panels (seed 1014) | choosing the best epoch |
| test | the printed C14 panel + the blank print | final score, never trained on |

No image in `train` or `val` contains a printed defect.

## Step 1: ground truth by differencing (`generate_dataset.py`)

1. Both PDFs are rendered at 4 pixels per millimetre, and their 6 sheets are stitched into the full
   855 × 396 mm panel, exactly as the sheets are taped together.
2. The two renders are identical except where the defects are printed. The pixel-wise difference
   `|defects − blank|`, thresholded and grouped (dilation, connected components), gives the three
   defect boxes with no manual annotation:

   | Defect | Sheet | Box on the panel (mm) |
   |---|---|---|
   | bird_dropping | A1 | 173.8 – 216.2 × 91.2 – 121.5 |
   | crack | B2 | 368.0 – 440.8 × 248.5 – 312.8 |
   | bird_dropping | C2 | 710.8 – 741.8 × 278.2 – 313.8 |

3. The ArUco marker is detected on the render (dictionary `ARUCO_MIP_36h12`, id 100).
4. Two files are written for the board: the panel's **reference profile**
   (`app/python/data/c14_profile.json`) and a grey **map of the healthy panel** at 1 px/mm
   (`c14_map.png`), which localisation registers camera views against.

## Step 2: procedural defects (`defects.py`)

Every training panel is the blank print with new defects drawn at random positions, sizes, shapes
and colours:

| Class | How it is drawn |
|---|---|
| `bird_dropping` | irregular cream body (polar noise contour), translucent halo, darker core, satellite droplets, sometimes a run-off streak |
| `crack` | impact star (3–7 branches, random-walk polylines with sub-branches) or one long crack, thin bright core with a soft glow |

Distractors that are not defects (dust specks, glare, shadows) are added too, so the detector learns
to reject them. Each box comes from the pixels actually drawn, so labels are exact.

## Step 3: synthetic phone views

Each image is a 640 × 480 view of a panel, randomised on:

| Factor | Range |
|---|---|
| Camera distance | footprint 170–470 mm wide |
| Framing | 70 % centred near a defect, 30 % anywhere (including edges and corners) |
| Rotation / tilt | ±10° in-plane, ±4 % perspective on each corner |
| Print | 70 % black-and-white (with printer tone curve), 30 % colour |
| Surface around the panel | paper, wood, grey, dark |
| Camera | exposure ×0.65–1.45, white balance, vignetting, focus blur, motion blur, sensor noise, JPEG compression |
| Lighting | specular glare (25 % of views), soft shadow (15 %) |

Labels are projected with the same perspective transform as the image.

| Split | Images | `bird_dropping` boxes | `crack` boxes | Images with no defect |
|---|---|---|---|---|
| train | 1232 | 696 | 606 | 312 |
| val | 211 | 121 | 134 | 41 |
| test | 240 | 108 | 67 | 86 |

## Step 4: transfer learning (`train.py`)

- Starting point: **YOLO11n** pre-trained on COCO, deliberately not the hackathon model, which had
  seen the test defects.
- Input size 320 × 320, the size used on the board.
- Ultralytics adds its own on-the-fly augmentation (mosaic, HSV jitter, scale, translation, flips).
- Training is limited by **time** (`--minutes`, default 70): Ultralytics fits the learning-rate
  schedule to the budget and keeps the best epoch on the validation set (`best.pt`).
- The best model is exported to **ONNX** (`opset 12`, static 1 × 3 × 320 × 320 input) and copied to
  `app/python/models/helioscan_yolo11n.onnx`, with `model_card.json`.

**The shipped model comes from an unfinished run.** It was stopped at epoch 9 of about 19 (37 minutes
of the 70-minute budget, laptop CPU) and the best checkpoint is epoch 7, so the learning rate never
finished decaying. A full run may do better, but that has not been measured.
`training/runs/helioscan/results.csv` holds the per-epoch log.

## Results

Measured with `tools/evaluate_detector.py`, which runs the board's own letterbox, ONNX Runtime session,
decoding and NMS. Precision and recall are at the board's threshold (conf 0.35).

| Model | Split | Precision | Recall | mAP50 | mAP50-95 | AP50 dropping | AP50 crack |
|---|---|---|---|---|---|---|---|
| **Shipped** | val (unseen procedural panels) | 0.927 | 0.992 | 0.983 | 0.722 | 0.980 | 0.986 |
| **Shipped** | test (printed defects, held out) | 0.961 | 0.994 | 1.000 | 0.780 | 1.000 | 1.000 |
| Hackathon | val (unseen procedural panels) | 0.927 | 0.902 | 0.951 | 0.597 | 0.999 | 0.904 |
| Hackathon | test (trained on these defects) | 0.962 | 1.000 | 0.999 | 0.811 | 1.000 | 0.999 |

The hackathon model's test row is not a fair score, because it trained on those defects. Its val row
is fair, and it shows that model already generalised reasonably to new synthetic defects. The rebuild
mainly helped on cracks and on box accuracy.

| Metric | Meaning |
|---|---|
| Precision | Of the boxes the model predicts, the fraction that are real defects. |
| Recall | Of the real defects, the fraction the model finds. |
| mAP50 | Mean average precision with a box counted as correct when it overlaps the true box by ≥ 50 % (IoU). 1.0 is perfect. |
| mAP50-95 | Same, averaged over overlap thresholds 50 %…95 %: also rewards precise box edges. |

## Reproduce

```bash
python -m venv .venv
.venv/Scripts/activate                      # Linux/macOS: source .venv/bin/activate
pip install --index-url https://download.pytorch.org/whl/cpu torch torchvision
pip install -r training/requirements.txt
python training/generate_dataset.py
python training/train.py --minutes 70
python tools/evaluate_detector.py --split val test
python tools/evaluate_pipeline.py           # end-to-end check of the board pipeline
```

`train.py` overwrites the model and its card, and its card reports the Ultralytics metrics, which
differ slightly from the board-code numbers above.

Real panels need real labelled images: see [SCALING.md](SCALING.md).
