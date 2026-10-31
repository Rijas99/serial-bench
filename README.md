# Hardware Check

Share this page with customers so they can test USB hardware **without installing Arduino IDE**.

Needs **Chrome or Edge** on a desktop PC (HTTPS or localhost).

## Quick start

```bash
npx --yes serve .
```

## For technicians — customize the shared link

```
https://yoursite.github.io/serial-bench/?baud=115200&expect=FLAP
```

| Param    | Purpose                                      |
|----------|----------------------------------------------|
| `baud`   | Serial baud rate (default 115200)            |
| `expect` | Optional text that means “pass” (e.g. `OK`)  |

## What non-tech users see

1. Plug in USB → **Connect device**
2. Big result: waiting / responding / working / no data
3. **Copy screenshot** or **Copy report** for support

## Layout

- **Left:** Advanced sidebar (Hide / Advanced to open) — baud, expect, send, export
- **Center:** Pause, Latest only, screenshot/report, log
- **Right:** Device status + Connect

## Continuous sensors

Use **Latest only** to show one live value, or **Pause** to freeze the screen.

## Network Ping Test

Open [Network Ping](https://rijas99.github.io/serial-bench/ping.html).

1. Download **HardwareCheckSetup.exe** from the page, open it on your Windows laptop, and choose **Install and open tester**. Close an older portable helper window first.
2. Open the Network Ping page normally in Chrome or Edge; allow local network / loopback access if the browser asks. It connects to the running helper automatically, without a private link or manual pairing.
3. Enter the device's local IPv4 address and press **Start ping**. Press **Stop** to finish; the current packet completes before stopping.
4. The helper runs in the system tray near the clock. Later visits and new browsers connect automatically, even after site storage is cleared. If it was stopped, use **Open installed helper** on the page or launch its installed executable again.

Setup supports Windows 10/11 x64 and requires no Python installation or administrator rights. It installs under `%LOCALAPPDATA%/HardwareCheckHelper` for the current user, with **Start with Windows** selected by default. It registers a `hardwarecheck-helper://open` link, which only opens the fixed tester page. The tray menu can open the tester, disable auto-start, or exit. Uninstall through Windows Settings > Apps. The downloads are unsigned, so Windows may show a security prompt. Each laptop needs its own setup. A webpage cannot silently install software or bypass browser prompts.

The separate portable **HardwareCheckHelper.exe** is also available in the release: open it when needed and keep its console window running. Portable mode does not install or change startup settings.

Real ICMP requests use the Windows `IcmpSendEcho` API with a one-second timeout. The panel displays reply time, sent/received/lost packets, loss percentage, and minimum/average/maximum latency. One request runs at a time, at most once per second. Starting a new test resets the statistics. The last 100 results remain visible; statistics cover the entire current test. A device that blocks ICMP may still be online.

### UDP command terminal

The same Network Ping page includes a **UDP command terminal**. Upgrade to helper **1.4.0** by running the current Setup once; existing settings and automatic startup are retained.

1. Enter the device's IPv4 address once at the top. Both ping and UDP use it. In the terminal, enter only the UDP port configured on the device.
2. Choose **Device IP** or **Broadcast** for sending, then press **Open UDP**. Reply and broadcast receive ports are configured automatically. There is no second IP input or laptop-port input.
3. Send a UTF-8 text command, optionally with NL/CR/CRLF, or select **Hex bytes** for binary commands. Press **Send** or Enter.
4. **TX** shows the actual send destination. **RX** shows incoming messages and each sender's IP/port, including unsolicited messages. **Receive broadcasts and messages from all local devices** is on by default; turn it off before opening UDP to accept only the selected device IP.
5. Use **Hex view**, **Clear terminal**, or **Export terminal** as needed. Press **Close UDP** when finished.

The helper opens a free reply port and, when receiving from all devices, an additional listener on the device UDP port. For example, device port `5005` automatically listens for broadcasts on laptop port `5005`, while replies to sent commands can use the free reply port. If the broadcast port is occupied, the page reports this and keeps the reply listener available; close the other app and reopen UDP to enable broadcast reception. Broadcast sends use the actual Windows interface subnet mask, falling back to limited broadcast `255.255.255.255` if the mask is unavailable. The shared IP stays read-only while UDP is open, so it cannot drift away from the active destination.

Allow the helper on **private networks** if Windows Firewall asks. The installer does not change firewall rules. UDP sending does not prove delivery or device execution; an RX message is needed to observe a reply. Commands are transmitted as bytes and are never run as Windows shell commands.

The helper's HTTP API remains loopback-only. UDP listeners accept the selected IP only, or all private/link-local/loopback source IPs when receive-all is enabled. They close on request. Browser page-close cleanup is attempted; a session also expires after two minutes without a browser heartbeat. At most four terminals can be open at once. Outgoing commands are limited to 4096 bytes and 20 sends per second. Received datagrams report their full byte count but display at most 4096 bytes per packet. The helper buffers 200 events per terminal, and the page displays the last 500; skipped events are reported when the buffer fills.

### Helper access and browser security

- The server binds only to `127.0.0.1:47831`, never a LAN interface.
- Production requests require the exact website origin `https://rijas99.github.io` and exact loopback Host header. Ping/UDP operations also require an authorized bearer credential.
- A JSON POST to `/connect` from that approved origin creates a random 256-bit temporary browser credential. Other origins, missing/opaque origins, wrong Host headers, GET requests, and form-style requests are rejected. The installed permanent key is never returned by this endpoint.
- Browser credentials are scoped to their origin and expire after one hour without activity. There are at most 64 credentials in memory. The page automatically obtains a new one when storage is empty, blocked, stale, or the helper has restarted. No external-app navigation is needed while the helper is running.
- GitHub Pages repositories share an origin; repository paths are not security boundaries. All content on this account's Pages origin must be trusted. Automatic connection authorizes that configured origin, not every website on GitHub Pages.
- The helper opens the ordinary `/serial-bench/ping.html` URL. Legacy private links remain supported for older clients; their fragments are removed immediately. Browser storage is optional—an in-memory credential works when storage is disabled.
- Health discovery reveals only the helper version, capabilities, and whether the supplied credential is valid. Responses are not cached. The permanent installed key remains under the current user's application folder and is removed on uninstall.
- Only literal private LAN, link-local, or loopback IPv4 addresses are accepted. No DNS lookups, shell commands, public targets, or scan endpoints.
- Browser local network permission remains under user / administrator control. Denial or an organization browser policy cannot be bypassed by the helper.
- Addresses and results go only to the laptop's loopback helper. No analytics or remote result uploads are included.

Browser behavior: [Chrome Local Network Access](https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access) and [Microsoft Edge Local Network Access](https://learn.microsoft.com/en-us/deployedge/ms-edge-local-network-access). ICMP API: [Microsoft IcmpSendEcho](https://learn.microsoft.com/en-us/windows/win32/api/icmpapi/nf-icmpapi-icmpsendecho).

### Tests

```powershell
npm ci
npm test
python -m unittest discover -s helper -p test_*.py
```

Browser checks use installed Microsoft Edge on Windows. If Edge is absent, install it first. Tests start their own static server and helper, so ports 8765 and 47831 must be free. USB serial tests use simulated ports; the ping integration uses real Windows loopback ICMP. Event-site hardware, Wi-Fi isolation, and firewall behavior need on-site checks.

For a local preview, run `python -m http.server 8765 --bind 127.0.0.1` and `python helper/bench_helper.py --dev`. Open `http://127.0.0.1:8765/ping.html` with the `#helper=...` fragment from the helper's private link. `--dev` adds only this exact development origin; normal production launches do not allow it.

### Build the portable Windows helper

```powershell
python -m venv helper/build-env
helper/build-env/Scripts/python -m pip install -r helper/requirements-build.txt
helper/build-env/Scripts/python -m PyInstaller --noconfirm --clean --onefile --console --name HardwareCheckHelper helper/bench_helper.py
```

Build the installer after building the helper:

```powershell
helper/build-env/Scripts/python -m PyInstaller --noconfirm --clean --onefile --windowed --name HardwareCheckSetup --add-data "dist/HardwareCheckHelper.exe;." helper/setup.py
```

The executables are `dist/HardwareCheckHelper.exe` and `dist/HardwareCheckSetup.exe`. To test the packaged helper rather than Python source, set `$env:HELPER_EXE` to its absolute path before `npm test`. The website's setup link points to `helper-v1.4.0`; its release also includes SHA-256 checksums. The repository's existing GitHub Pages workflow publishes the website on pushes to `master`.
