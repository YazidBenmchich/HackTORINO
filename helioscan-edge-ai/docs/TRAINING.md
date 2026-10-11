# Training the YOLO defect detector

## Why a synthetic dataset

A detector learns from labelled images. We have no photographs of the printed panel, but we have
something better for a start: the **exact source files** (the two PDFs). From them we can render
any number of realistic phone views, and we know exactly where every defect is. This is called
**synthetic data with domain randomisation**: the images vary randomly in every way the real
camera may vary, so the model learns the defects and not one particular image.

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
4. All of this is saved as the panel's **reference profile** (`app/python/data/c14_profile.json`),
   used on the board.

## Step 2: synthetic phone views

Each training image is a 640 × 480 view of the panel, randomised on:

| Factor | Range |
|---|---|
| Camera distance | footprint 170–470 mm wide (≈ 15–45 cm above the panel) |
| Framing | 70 % centred near a defect, 30 % anywhere (including edges and corners) |
| Rotation / tilt | ±10° in-plane, ±4 % perspective on each corner |
| Print | 70 % black-and-white (with printer tone curve), 30 % colour |
| Surface around the panel | paper, wood, grey, dark |
| Camera | exposure ×0.65–1.45, white balance, vignetting, focus blur, motion blur, sensor noise, JPEG quality 45–90 |
| Negatives | 25 % of views use the blank print; with framing, about a third of all images contain no defect |

Labels are projected with the same perspective transform as the image. A defect less than half
visible is not labelled.

Dataset used for the delivered model: **300 training images, 80 validation images** (generated
with different random seeds, so the validation images are never seen during training).

## Step 3: transfer learning (`train.py`)

- Starting point: **YOLO11n** pre-trained on COCO (80 everyday object classes). Its early layers
  already know edges, textures and shapes; fine-tuning teaches it our two classes. This is why a
  few hundred images and 15 minutes on a laptop CPU are enough.
- Input size 320 × 320 (the size used on the board).
- Ultralytics adds its own on-the-fly augmentation (mosaic, HSV jitter, scale, translation, flips).
- Training is limited by **time** (`--minutes 15`): Ultralytics fits the learning-rate schedule to
  the budget and keeps the best epoch on the validation set (`best.pt`).
- The best model is exported to **ONNX** (`opset 12`, static 1 × 3 × 320 × 320 input) and copied
  to `app/python/models/helioscan_yolo11n.onnx`, with `model_card.json` (classes, input format,
  validation metrics).

## Reading the metrics

| Metric | Meaning |
|---|---|
| Precision | Of the boxes the model predicts, the fraction that are real defects. |
| Recall | Of the real defects, the fraction the model finds. |
| mAP50 | Mean average precision with a box counted as correct when it overlaps the true box by ≥ 50 % (IoU). 1.0 is perfect. |
| mAP50-95 | Same, averaged over overlap thresholds 50 %…95 %: also rewards precise box edges. |

Curves, confusion matrix and predictions on validation batches are written to
`training/runs/c14/` (`results.png`, `confusion_matrix.png`, `val_batch*_pred.jpg`).

## Reproduce

```bash
python -m venv .venv
.venv/Scripts/activate                      # Linux/macOS: source .venv/bin/activate
pip install --index-url https://download.pytorch.org/whl/cpu torch torchvision
pip install -r training/requirements.txt
python training/generate_dataset.py --train 300 --val 80
python training/train.py --minutes 15
python tools/evaluate_pipeline.py           # end-to-end check of the board pipeline
```

## Limits (honest scope)

- The model is trained on renders of **this** printed panel. It detects these defect types on this
  kind of print; it is not a general solar-panel model. Real panels need real labelled images
  (see [SCALING.md](SCALING.md)).
- The synthetic camera model is an approximation of a phone camera. Validation scores measure
  performance on synthetic views; the end-to-end evaluation and your tests with the real phone are
  the reference for the demo.
