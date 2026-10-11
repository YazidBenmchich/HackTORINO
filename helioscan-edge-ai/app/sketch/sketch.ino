// HelioScan edge inspection — STM32U585 microcontroller side.
//
// The Linux side (python/main.py) runs the vision pipeline and calls these functions through
// the Bridge (RPC) to give a physical status signal on the payload:
//   scan_state(state)   0 = idle, 1 = inspecting (slow heartbeat), 2 = scan complete (solid on)
//   defect_alert(n)     n quick flashes when defect number n is confirmed
//
// The LED pattern runs in loop() without blocking, so Bridge calls always return immediately.

#include "Arduino_RouterBridge.h"

const unsigned long FLASH_MS = 120;
const unsigned long HEARTBEAT_MS = 900;

volatile int scanState = 0;
volatile int pendingFlashes = 0;

int flashesLeft = 0;          // remaining on/off half-cycles of the current alert
unsigned long lastToggle = 0;
bool ledOn = false;

void setLed(bool on) {
  ledOn = on;
  digitalWrite(LED_BUILTIN, on ? LOW : HIGH);  // built-in LED is active-low
}

void scan_state(int state) {
  scanState = state;
}

void defect_alert(int number) {
  pendingFlashes = number;
}

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  setLed(false);

  Bridge.begin();  // must be called before any other Bridge function
  Bridge.provide("scan_state", scan_state);
  Bridge.provide("defect_alert", defect_alert);
}

void loop() {
  unsigned long now = millis();

  if (pendingFlashes > 0 && flashesLeft == 0) {
    flashesLeft = pendingFlashes * 2;
    pendingFlashes = 0;
    setLed(false);
    lastToggle = now;
  }

  if (flashesLeft > 0) {
    if (now - lastToggle >= FLASH_MS) {
      setLed(!ledOn);
      flashesLeft--;
      lastToggle = now;
    }
    return;
  }

  if (scanState == 2) {
    setLed(true);
  } else if (scanState == 1) {
    if (now - lastToggle >= HEARTBEAT_MS) {
      setLed(!ledOn);
      lastToggle = now;
    }
  } else {
    setLed(false);
  }
}
