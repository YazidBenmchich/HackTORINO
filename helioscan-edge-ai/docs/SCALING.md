# From the printed demo to real solar farms

The demo inspects one printed panel with a phone. The architecture is the one a real inspection
payload would use; this page lists what stays, what changes, and in which order.

## What carries over unchanged

| Component | Why it scales |
|---|---|
| Edge inference (ONNX Runtime on the UNO Q) | No cloud link needed in the field; the model file is swapped without code changes. |
| YOLO detector + class-aware NMS | Same detector family is the standard for aerial PV defect detection; more classes = a longer `classes` list in the model card. |
| ByteTrack-style tracking | One physical defect seen in many frames is reported once, whatever the number of frames per panel. |
| Mission / reference verification | The panel profile becomes one record per panel of the plant (as-built database). |
| Report (JSON) | Ready to be pushed to a maintenance system (CMMS) or a GIS layer. |
| MCU over the Bridge | The STM32 side can drive real payload hardware: gimbal trigger, status LEDs, thermal sensor on I²C. |

## What changes for real panels

1. **Real training data instead of synthetic renders.**
   The generator (`training/generate_dataset.py`) exists because no photo of the printed panel
   was available. For real panels, the same `train.py` is fed with labelled drone images
   (RGB and thermal). Public aerial PV defect datasets exist and can bootstrap the model before
   fine-tuning on the operator's own plant. Domain randomisation stays useful for rare defect
   types.
2. **Thermal channel.** Hot spots, bypass-diode failures and cell mismatch are only visible in
   infrared. The planned payload has a thermal camera: either a second YOLO model on the thermal
   image, or a fused RGB + thermal input. The tracker and the report already handle any class
   name.
3. **Positioning.** On a drone, the position of each image comes from GNSS/RTK and the gimbal
   attitude. Detections are projected on the ground (georeferencing) instead of being assigned to
   a sheet by the inspection path. The ArUco marker becomes a ground control point, or disappears.
4. **Coverage path.** The U-shaped pass becomes a flight plan generated per row of panels (the
   same "follow the edge, turn at the corner" logic, executed by the flight controller).
5. **Hardware acceleration.** YOLO11n at 320 px is sized for the UNO Q CPU. Larger models or
   higher resolutions need an NPU/GPU target (ONNX models export to TensorRT, TFLite, etc.).

## Suggested next steps

1. Photograph the printed panel with the phone (a few hundred frames), label them, and add them to
   the synthetic set: measures and closes the synthetic-to-real gap.
2. Add the thermal camera on the MCU (I²C) and a `hotspot` class.
3. Log every inspection report with a timestamp and GPS position from the phone.
