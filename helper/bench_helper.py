"""Hardware Check portable ICMP helper. Python source; packaged with PyInstaller."""

import argparse
from collections import deque
import ctypes
from ctypes import wintypes
import hmac
from datetime import datetime, timezone
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

VERSION = "1.2.0"
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


def validate_port(value, allow_auto=False):
    if type(value) is not int or not (0 if allow_auto else 1) <= value <= 65535:
        raise ValueError("Port must be 1–65535 (or 0 for an automatic receive port).")
    return value


class UdpSession:
    MAX_BYTES = 4096
    IDLE_SECONDS = 120

    def __init__(self, address, remote_port, local_port):
        self.address = validate_ip(address)
        self.remote_port = validate_port(remote_port)
        self.id = secrets.token_urlsafe(24)
        self.lock = threading.RLock()
        self.events = deque(maxlen=200)
        self.sequence = self.sent = self.received = 0
        self.last_seen = time.monotonic()
        self.last_send = 0.0
        self.closed = False
        self.error = ""
        self.socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            self.socket.bind(("0.0.0.0", validate_port(local_port, allow_auto=True)))
            self.socket.settimeout(0.25)
            self.local_port = self.socket.getsockname()[1]
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as route:
                route.connect((self.address, self.remote_port))
                self.local_ip = route.getsockname()[0]
        except (OSError, ValueError):
            self.socket.close()
            raise
        self.thread = threading.Thread(target=self.receive, daemon=True)
        self.thread.start()

    def record(self, kind, data, address, port):
        with self.lock:
            self.sequence += 1
            shown = data[:self.MAX_BYTES]
            self.events.append({"seq": self.sequence, "kind": kind,
                "time": datetime.now(timezone.utc).isoformat(), "ip": address, "port": port,
                "text": shown.decode("utf-8", errors="replace"), "hex": shown.hex(" ").upper(),
                "bytes": len(data), "truncated": len(data) > self.MAX_BYTES})

    def receive(self):
        while not self.closed:
            if time.monotonic() - self.last_seen > self.IDLE_SECONDS:
                self.error = "UDP session expired after two minutes without a browser heartbeat."
                self.close()
                return
            try:
                data, (address, port) = self.socket.recvfrom(65535)
                if address != self.address:
                    continue
                with self.lock:
                    self.received += 1
                    self.record("rx", data, address, port)
            except socket.timeout:
                continue
            except OSError as error:
                # Windows reports ICMP port-unreachable as WSAECONNRESET on UDP sockets.
                if getattr(error, "winerror", None) == 10054:
                    self.record("sys", b"Device reported UDP port unreachable; still listening.", self.address, self.remote_port)
                    continue
                if not self.closed:
                    self.error = "UDP receive stopped. Close UDP and open it again."
                    self.close()
                return

    def send(self, body):
        value = body.get("data")
        if not isinstance(value, str):
            raise ValueError("Enter a command to send.")
        encoding = body.get("encoding", "text")
        if encoding == "hex":
            try:
                data = bytes.fromhex(value)
            except ValueError:
                raise ValueError("Hex requires complete byte pairs, for example 01 FF 0A.") from None
        elif encoding == "text":
            ending_name = body.get("ending", "none")
            if not isinstance(ending_name, str):
                raise ValueError("Choose a valid line ending.")
            ending = {"none": "", "nl": "\n", "cr": "\r", "crlf": "\r\n"}.get(ending_name)
            if ending is None:
                raise ValueError("Choose a valid line ending.")
            data = (value + ending).encode("utf-8")
        else:
            raise ValueError("Choose text or hex encoding.")
        if not 0 < len(data) <= self.MAX_BYTES:
            raise ValueError("A command must contain 1–4096 bytes.")
        with self.lock:
            if self.closed:
                raise ValueError("UDP is closed. Open UDP again.")
            if time.monotonic() - self.last_send < 0.05:
                raise ValueError("Wait a moment before sending another command.")
            self.socket.sendto(data, (self.address, self.remote_port))
            self.last_send = self.last_seen = time.monotonic()
            self.sent += 1
            self.record("tx", data, self.address, self.remote_port)

    def snapshot(self, after=0):
        if type(after) is not int or after < 0:
            raise ValueError("Invalid terminal cursor.")
        with self.lock:
            self.last_seen = time.monotonic()
            events = [event for event in self.events if event["seq"] > after][:100]
            return {"session": self.id, "localIp": self.local_ip, "localPort": self.local_port,
                    "ip": self.address, "remotePort": self.remote_port, "sent": self.sent,
                    "received": self.received, "closed": self.closed, "error": self.error,
                    "events": events, "cursor": events[-1]["seq"] if events else after,
                    "skipped": max(0, self.events[0]["seq"] - after - 1) if self.events else 0}

    def close(self):
        with self.lock:
            self.closed = True
            self.socket.close()


class UdpTerminals:
    def __init__(self):
        self.sessions = {}
        self.lock = threading.Lock()

    def open(self, body):
        with self.lock:
            self.sessions = {key: value for key, value in self.sessions.items() if not value.closed}
            if len(self.sessions) >= 4:
                raise ValueError("Four UDP terminals are already open. Close one before opening another.")
            session = UdpSession(body.get("ip"), body.get("remotePort"), body.get("localPort", 0))
            self.sessions[session.id] = session
            return session.snapshot()

    def get(self, key):
        with self.lock:
            if not isinstance(key, str) or key not in self.sessions:
                raise ValueError("UDP session not found. Open UDP again.")
            return self.sessions[key]

    def close_all(self):
        with self.lock:
            for session in self.sessions.values():
                session.close()
            self.sessions.clear()


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
        self.udp = UdpTerminals()
        super().__init__(("127.0.0.1", port), Handler)

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(3)
        return connection, address

    def server_close(self):
        self.udp.close_all()
        super().server_close()


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
                               "paired": self.authorized(), "capabilities": ["ping", "udp"]})
        else:
            self.respond(404, {"error": "Unknown endpoint."})

    def do_POST(self):
        if not self.allowed() or not self.authorized():
            self.respond(403, {"error": "Open the paired page from the helper window."})
            return
        if self.path not in ("/ping", "/udp/open", "/udp/read", "/udp/send", "/udp/close"):
            self.respond(404, {"error": "Unknown endpoint."})
            return
        try:
            if self.headers.get("Transfer-Encoding"):
                raise ValueError("Chunked requests are not accepted.")
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= (32768 if self.path.startswith("/udp/") else 256):
                raise ValueError("Invalid request size.")
            if self.headers.get_content_type() != "application/json":
                raise ValueError("Send JSON with a local IPv4 address.")
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError("Send a JSON object.")
            if self.path.startswith("/udp/"):
                self.handle_udp(body)
                return
            address = validate_ip(body.get("ip"))
        except (ValueError, UnicodeError) as error:
            self.respond(400, {"error": str(error)})
            return
        except OSError as error:
            self.respond(400, {"error": "UDP could not open or send. Check the network and make sure the receive port is free. " + str(error)})
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

    def handle_udp(self, body):
        after = body.get("after", 0)
        if type(after) is not int or after < 0:
            raise ValueError("Invalid terminal cursor.")
        if self.path == "/udp/open":
            result = self.server.udp.open(body)
        else:
            session = self.server.udp.get(body.get("session"))
            if self.path == "/udp/send":
                session.send(body)
            elif self.path == "/udp/close":
                session.close()
            result = session.snapshot(after)
        self.respond(200, result)


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
