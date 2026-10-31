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

1. Download **HardwareCheckHelper.exe** from the page, and open it on your Windows laptop.
2. Use the paired page opened by the helper in Chrome or Edge; allow local network / loopback access if the browser asks. If another browser opens, copy the private link from the helper window into Chrome or Edge.
3. Enter the device's local IPv4 address and press **Start ping**. Press **Stop** to finish; the current packet completes before stopping.
4. Keep the helper window open while testing. Close it or press Ctrl+C when finished.

The portable helper supports Windows 10/11 x64, requires no Python installation or administrator rights, and does not install a service or start with Windows. It is unsigned, so Windows may show a security prompt. Each laptop needs its own copy. Installer and system-tray support are not included in this version.

Real ICMP requests use the Windows `IcmpSendEcho` API with a one-second timeout. The panel displays reply time, sent/received/lost packets, loss percentage, and minimum/average/maximum latency. One request runs at a time, at most once per second. Starting a new test resets the statistics. The last 100 results remain visible; statistics cover the entire current test. A device that blocks ICMP may still be online.

### Helper access and browser security

- The server binds only to `127.0.0.1:47831`, never a LAN interface.
- Production requests require the exact website origin `https://rijas99.github.io`, the exact loopback Host header, and a random 256-bit pairing key for ping operations. Keys change on every helper launch.
- GitHub Pages repositories share an origin. The per-launch secret key protects ping access from other pages on that origin; CORS alone cannot restrict access to a repository path.
- The helper opens only `/serial-bench/ping.html#helper=...`. The page removes the fragment immediately and retains the key in this tab's session storage (or memory if storage is disabled). Keep the paired link private.
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

The executable is `dist/HardwareCheckHelper.exe`. To test the packaged executable rather than Python source, set `$env:HELPER_EXE` to its absolute path before `npm test`. The website's download link points to the versioned `helper-v1.0.0` release asset; its release also includes the executable's SHA-256 checksum. The repository's existing GitHub Pages workflow publishes the website on pushes to `master`.
