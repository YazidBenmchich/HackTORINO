# HelioScan edge inspection — Arduino UNO Q application (Linux side, Python).
#
# The phone is the camera: its browser opens the page served by the WebUI brick (HTTPS, port 7000),
# streams JPEG frames over Socket.IO, and draws the results. Every frame is processed here, on the
# UNO Q: panel segmentation, ArUco marker, YOLO defect detection (ONNX Runtime), tracking and the
# inspection mission. Defect alerts are forwarded to the STM32 microcontroller through the Bridge.

import logging

from arduino.app_utils import App, Bridge
from arduino.app_bricks.web_ui import WebUI

from helioscan.pipeline import InspectionPipeline
from helioscan.service import InspectionService

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("helioscan")


def notify_mcu(method, value):
    Bridge.call(method, value)


pipeline = InspectionPipeline()
service = InspectionService(pipeline, notify_mcu=notify_mcu)
log.info("model %s, classes %s, validation %s", pipeline.model_card["model"],
         pipeline.model_card["classes"], pipeline.model_card["validation"])

# HTTPS is required: phone browsers only give camera access to secure pages
ui = WebUI(use_tls=True)
for event, handler in service.handlers().items():
    ui.on_message(event, handler)  # the handler's return value is sent back as "<event>_response"
ui.expose_api("GET", "/report", service.on_report)

App.run()
