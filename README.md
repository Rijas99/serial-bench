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
2. Use the paired page opened by the helper in Chrome or Edge; allow local network / loopback access if the browser asks. If another browser opens, copy the private link from the helper window into Chrome or Edge.
3. Enter the device's local IPv4 address and press **Start ping**. Press **Stop** to finish; the current packet completes before stopping.
4. The helper runs in the system tray near the clock. On later visits, this browser remembers its pairing and reconnects automatically. If stopped, use **Open installed helper** on the page.

Setup supports Windows 10/11 x64 and requires no Python installation or administrator rights. It installs under `%LOCALAPPDATA%/HardwareCheckHelper` for the current user, with **Start with Windows** selected by default. It registers a `hardwarecheck-helper://open` link, which only opens the fixed tester page. The tray menu can open the tester, disable auto-start, or exit. Uninstall through Windows Settings > Apps. The downloads are unsigned, so Windows may show a security prompt. Each laptop needs its own setup. A webpage cannot silently install software or bypass browser prompts.

The separate portable **HardwareCheckHelper.exe** is also available in the release: open it when needed and keep its console window running. Portable mode does not install or change startup settings.

Real ICMP requests use the Windows `IcmpSendEcho` API with a one-second timeout. The panel displays reply time, sent/received/lost packets, loss percentage, and minimum/average/maximum latency. One request runs at a time, at most once per second. Starting a new test resets the statistics. The last 100 results remain visible; statistics cover the entire current test. A device that blocks ICMP may still be online.

### UDP command terminal

The same Network Ping page includes a **UDP command terminal**. Upgrade to helper **1.2.0** by running the current Setup once; existing installed pairing and automatic startup are retained.

1. Enter the device's IPv4 address and the UDP port configured on the device. No destination port is assumed.
2. Enter the laptop receive port expected by the device, or leave **0** to choose a free port. Press **Open UDP**. The page shows the actual laptop IP and receive port.
3. Send a UTF-8 text command, optionally with NL/CR/CRLF, or select **Hex bytes** for binary commands. Press **Send** or Enter.
4. **TX** shows commands sent by the laptop. **RX** shows messages received from the selected device IP, including unsolicited messages before any command. Replies may use a different source port on that IP.
5. Use **Hex view**, **Clear terminal**, or **Export terminal** as needed. Press **Close UDP** when finished.

The device must send to the laptop's displayed IP and receive port. Allow the helper on **private networks** if Windows Firewall asks. The installer does not change firewall rules. UDP sending does not prove delivery or device execution; an RX message is needed to observe a reply. Commands are transmitted as bytes and are never run as Windows shell commands.

The helper's HTTP API remains loopback-only. Each open UDP socket listens on the chosen port across the laptop's network interfaces, accepts only datagrams from the selected local device IP, and closes on request. Browser page-close cleanup is attempted; a session also expires after two minutes without a browser heartbeat. At most four terminals can be open at once. Outgoing commands are limited to 4096 bytes and 20 sends per second. Received datagrams report their full byte count but display at most 4096 bytes per packet. The helper buffers 200 events per terminal, and the page displays the last 500; skipped events are reported when the buffer fills.

### Helper access and browser security

- The server binds only to `127.0.0.1:47831`, never a LAN interface.
- Production requests require the exact website origin `https://rijas99.github.io`, the exact loopback Host header, and a random 256-bit pairing key for ping operations. The installed helper retains its key in the current user's application folder, so browser pairing survives sign-in/restarts. Uninstall removes it. Portable keys change on each launch.
- GitHub Pages repositories share an origin. The secret pairing key is needed in addition to CORS; repository paths are not browser security boundaries. All content on this account's Pages origin must be trusted because browser storage is shared across it.
- The helper opens only `/serial-bench/ping.html#helper=...`. The page removes the fragment immediately and remembers the key in browser local storage (or tab/memory if storage is disabled). Keep the paired link private. Clearing site data removes browser pairing; **Open installed helper** restores it.
- Health discovery reveals only the helper version and whether the supplied key is valid. No endpoint returns the key. Responses are not cached.
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

The executables are `dist/HardwareCheckHelper.exe` and `dist/HardwareCheckSetup.exe`. To test the packaged helper rather than Python source, set `$env:HELPER_EXE` to its absolute path before `npm test`. The website's setup link points to `helper-v1.2.0`; its release also includes SHA-256 checksums. The repository's existing GitHub Pages workflow publishes the website on pushes to `master`.
