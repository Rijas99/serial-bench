"""Hardware Check portable ICMP helper. Python source; packaged with PyInstaller."""

import argparse
import ctypes
from ctypes import wintypes
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import secrets
import socket
import struct
import sys
import threading
import time
import webbrowser

VERSION = "1.1.0"
PORT = 47831
SITE_ORIGIN = "https://rijas99.github.io"
SITE_PAGE = SITE_ORIGIN + "/serial-bench/ping.html"
LOCAL_RANGES = tuple(ipaddress.ip_network(n) for n in (
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "127.0.0.0/8"
))


def validate_ip(value):
    if not isinstance(value, str):
        raise ValueError("Enter a local IPv4 address, such as 192.168.1.20.")
    try:
        address = ipaddress.IPv4Address(value)
    except ipaddress.AddressValueError:
        raise ValueError("Enter a valid IPv4 address, such as 192.168.1.20.") from None
    if not any(address in network for network in LOCAL_RANGES):
        raise ValueError("Use a private LAN, link-local, or loopback IPv4 address.")
    return str(address)


class IPOptions(ctypes.Structure):
    _fields_ = [("Ttl", wintypes.BYTE), ("Tos", wintypes.BYTE),
                ("Flags", wintypes.BYTE), ("OptionsSize", wintypes.BYTE),
                ("OptionsData", ctypes.c_void_p)]


class EchoReply(ctypes.Structure):
    _fields_ = [("Address", wintypes.DWORD), ("Status", wintypes.DWORD),
                ("RoundTripTime", wintypes.DWORD), ("DataSize", wintypes.WORD),
                ("Reserved", wintypes.WORD), ("Data", ctypes.c_void_p),
                ("Options", IPOptions)]


def ping_once(address):
    """Send real ICMP through Windows, without a shell, raw sockets, or admin rights."""
    address = validate_ip(address)
    api = ctypes.WinDLL("iphlpapi.dll", use_last_error=True)
    api.IcmpCreateFile.restype = wintypes.HANDLE
    api.IcmpCloseHandle.argtypes = [wintypes.HANDLE]
    api.IcmpSendEcho.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p,
                                wintypes.WORD, ctypes.c_void_p, ctypes.c_void_p,
                                wintypes.DWORD, wintypes.DWORD]
    api.IcmpSendEcho.restype = wintypes.DWORD
    handle = api.IcmpCreateFile()
    if handle == ctypes.c_void_p(-1).value:
        raise OSError(ctypes.get_last_error(), "Windows could not open ICMP.")
    try:
        data = ctypes.create_string_buffer(b"Hardware Check ICMP test".ljust(32, b"."))
        buffer = ctypes.create_string_buffer(ctypes.sizeof(EchoReply) + 32 + 8)
        destination = struct.unpack("=I", socket.inet_aton(address))[0]
        count = api.IcmpSendEcho(handle, destination, data, 32, None, buffer, len(buffer), 1000)
        if count:
            reply = EchoReply.from_buffer(buffer)
            status = reply.Status
            if status == 0:
                return {"ip": address, "ok": True, "ms": reply.RoundTripTime,
                        "ttl": reply.Options.Ttl, "message": "Reply received"}
        else:
            status = ctypes.get_last_error()
        messages = {11010: "Request timed out", 11002: "Destination network unreachable",
                    11003: "Destination host unreachable", 11013: "TTL expired in transit",
                    11050: "General network failure"}
        return {"ip": address, "ok": False, "ms": None,
                "message": messages.get(status, "No reply (Windows status %s)" % status)}
    finally:
        api.IcmpCloseHandle(handle)


class HelperServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 8

    def __init__(self, port=PORT, dev=False, token=None):
        self.token = token or secrets.token_urlsafe(32)
        self.allowed_origins = {SITE_ORIGIN}
        if dev:
            self.allowed_origins.add("http://127.0.0.1:8765")
        self.ping_lock = threading.Lock()
        self.last_ping = 0.0
        super().__init__(("127.0.0.1", port), Handler)

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(3)
        return connection, address


class Handler(BaseHTTPRequestHandler):
    server_version = "HardwareCheckHelper/" + VERSION

    def log_message(self, *_args):
        pass  # Pairing keys and requested device addresses stay out of logs.

    def allowed(self):
        expected_host = "127.0.0.1:%s" % self.server.server_port
        return (self.headers.get("Host") == expected_host
                and self.headers.get("Origin") in self.server.allowed_origins)

    def authorized(self):
        return hmac.compare_digest(self.headers.get("Authorization", "").encode("utf-8"),
                                   ("Bearer " + self.server.token).encode("utf-8"))

    def respond(self, code, body=None):
        payload = json.dumps(body or {}).encode("utf-8")
        self.send_response(code)
        if self.allowed():
            self.send_header("Access-Control-Allow-Origin", self.headers["Origin"])
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Vary", "Origin")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_OPTIONS(self):
        self.respond(200 if self.allowed() else 403)

    def do_GET(self):
        if not self.allowed():
            self.respond(403, {"error": "Website origin or host is not allowed."})
        elif self.path == "/health":
            self.respond(200, {"service": "hardware-check-helper", "version": VERSION,
                               "paired": self.authorized()})
        else:
            self.respond(404, {"error": "Unknown endpoint."})

    def do_POST(self):
        if not self.allowed() or not self.authorized():
            self.respond(403, {"error": "Open the paired page from the helper window."})
            return
        if self.path != "/ping":
            self.respond(404, {"error": "Unknown endpoint."})
            return
        try:
            if self.headers.get("Transfer-Encoding"):
                raise ValueError("Chunked requests are not accepted.")
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 256:
                raise ValueError("Invalid request size.")
            if self.headers.get_content_type() != "application/json":
                raise ValueError("Send JSON with a local IPv4 address.")
            body = json.loads(self.rfile.read(length))
            address = validate_ip(body.get("ip") if isinstance(body, dict) else None)
        except (ValueError, UnicodeError) as error:
            self.respond(400, {"error": str(error)})
            return
        if not self.server.ping_lock.acquire(blocking=False):
            self.respond(429, {"error": "A ping is already running on this laptop."})
            return
        try:
            if time.monotonic() - self.server.last_ping < 0.75:
                self.respond(429, {"error": "Wait a moment before sending another ping."})
                return
            self.server.last_ping = time.monotonic()
            self.respond(200, ping_once(address))
        except OSError:
            self.respond(500, {"error": "Windows could not send ICMP. Check the network and retry."})
        finally:
            self.server.ping_lock.release()


def main():
    parser = argparse.ArgumentParser(description="Hardware Check ICMP helper for Windows")
    parser.add_argument("--no-browser", action="store_true", help="Do not open the website automatically")
    parser.add_argument("--dev", action="store_true", help="Also allow the local developer preview")
    parser.add_argument("--background", action="store_true", help="Run installed helper in the system tray")
    parser.add_argument("--open-page", action="store_true", help="Start installed helper and open its paired page")
    args = parser.parse_args()
    if sys.platform != "win32":
        sys.exit("This helper needs Windows 10 or 11.")
    installed = args.background or args.open_page
    key = None
    if installed:
        import windows_setup
        key = windows_setup.pairing_token()
    try:
        server = HelperServer(dev=args.dev, token=key)
    except OSError:
        if installed:
            if args.open_page:
                webbrowser.open(SITE_PAGE + "#helper=" + key)
            return
        sys.exit("Could not start: another helper may already be running. Close it and try again.")
    paired_page = SITE_PAGE + "#helper=" + server.token
    print("Hardware Check Network Helper " + VERSION, flush=True)
    print("Keep this window open while testing. Press Ctrl+C to quit.", flush=True)
    print("Only the Hardware Check website can use this helper with its pairing key.", flush=True)
    print("To reopen the paired page, copy this private link into Chrome or Edge:", flush=True)
    print(paired_page, flush=True)
    if args.open_page or (not installed and not args.no_browser):
        webbrowser.open(paired_page)
    if installed:
        run_tray(server, paired_page)
        return
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def run_tray(server, paired_page):
    import pystray
    from PIL import Image, ImageDraw
    import windows_setup

    image = Image.new("RGB", (64, 64), "#0f7a5f")
    drawing = ImageDraw.Draw(image)
    for x in range(16, 49, 8):
        drawing.rectangle((x, 16, x + 2, 48), fill="white")
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateEventW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR]
    kernel.CreateEventW.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    event = kernel.CreateEventW(None, True, False, windows_setup.stop_event_name())
    if not event:
        server.server_close()
        raise OSError("Could not create the helper stop event.")
    threading.Thread(target=server.serve_forever, daemon=True).start()

    def quit_helper(icon, _item=None):
        icon.stop()

    icon = pystray.Icon("HardwareCheckHelper", image, "Hardware Check Helper", menu=pystray.Menu(
        pystray.MenuItem("Open network tester", lambda: webbrowser.open(paired_page), default=True),
        pystray.MenuItem("Disable Windows auto-start", windows_setup.disable_startup),
        pystray.MenuItem("Exit helper", quit_helper),
    ))

    def wait_for_stop():
        kernel.WaitForSingleObject(event, 0xFFFFFFFF)
        icon.stop()

    threading.Thread(target=wait_for_stop, daemon=True).start()
    # Hide only this executable's own console; the portable mode keeps its window.
    kernel.GetConsoleWindow.restype = wintypes.HWND
    ctypes.windll.user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    console = kernel.GetConsoleWindow()
    if console and getattr(sys, "frozen", False):
        ctypes.windll.user32.ShowWindow(console, 0)
    try:
        icon.run()
    finally:
        server.shutdown()
        server.server_close()
        kernel.CloseHandle(event)


if __name__ == "__main__":
    main()
