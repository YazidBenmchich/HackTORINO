"""Local test server: runs the exact UNO Q pipeline on a computer, no board needed.

It mirrors the Arduino WebUI brick used on the board (python/main.py):
  - serves app/assets over HTTPS (self-signed certificate) on port 7000,
  - Socket.IO at /socket.io,
  - each message handler runs in a worker thread and its return value is emitted back as
    "<event>_response".
The phone page, the pipeline and the YOLO model are the same files as on the board.

Usage
-----
    python tools/dev_server.py            then open https://<computer-ip>:7000 on the phone
"""

from __future__ import annotations

import argparse
import asyncio
import datetime
import ipaddress
import socket
import sys
from pathlib import Path

import socketio
import uvicorn
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app" / "python"))

from helioscan.pipeline import InspectionPipeline  # noqa: E402
from helioscan.service import InspectionService  # noqa: E402


def lan_addresses() -> list[str]:
    ips = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    return sorted(ip for ip in ips if not ip.startswith(("127.", "169.254.")))


def make_certificate(folder: Path, ips: list[str]) -> tuple[Path, Path]:
    """Self-signed certificate for localhost and the computer's LAN addresses."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    folder.mkdir(parents=True, exist_ok=True)
    cert_file, key_file = folder / "cert.pem", folder / "key.pem"
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "HelioScan local")])
    san = [x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]
    san += [x509.IPAddress(ipaddress.ip_address(ip)) for ip in ips]
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(days=1))
            .not_valid_after(now + datetime.timedelta(days=365))
            .add_extension(x509.SubjectAlternativeName(san), critical=False)
            .sign(key, hashes.SHA256()))
    cert_file.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_file.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL,
                                           serialization.NoEncryption()))
    return cert_file, key_file


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=7000)
    ap.add_argument("--http", action="store_true", help="plain HTTP (camera then only works on localhost)")
    args = ap.parse_args()

    pipeline = InspectionPipeline()
    service = InspectionService(pipeline)
    handlers = service.handlers()

    sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins="*", max_http_buffer_size=10 * 1024 * 1024)

    @sio.on("*")
    async def any_event(event, sid, data=None):
        handler = handlers.get(event)
        if handler is None:
            return
        result = await asyncio.to_thread(handler, sid, data)
        if result is not None:
            await sio.emit(f"{event}_response", result, to=sid)

    app = FastAPI()
    app.get("/report")(lambda: service.on_report())
    app.mount("/", StaticFiles(directory=ROOT / "app" / "assets", html=True), name="assets")
    asgi = socketio.ASGIApp(sio, other_asgi_app=app)

    ips = lan_addresses()
    ssl = {}
    scheme = "http"
    if not args.http:
        cert, key = make_certificate(ROOT / "tools" / ".cert", ips)
        ssl = {"ssl_certfile": str(cert), "ssl_keyfile": str(key)}
        scheme = "https"
    print(f"\nHelioScan local server ({pipeline.model_card['model']})")
    print(f"  this computer : {scheme}://localhost:{args.port}")
    for ip in ips:
        print(f"  phone         : {scheme}://{ip}:{args.port}")
    print()
    uvicorn.run(asgi, host="0.0.0.0", port=args.port, log_level="warning", **ssl)


if __name__ == "__main__":
    main()
