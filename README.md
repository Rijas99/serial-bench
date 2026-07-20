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

## Advanced

Expand **Advanced options** for baud, expect text, hex view, send commands, export log.
