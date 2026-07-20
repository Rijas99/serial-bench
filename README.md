# Serial Bench

Browser serial monitor for Arduino and similar microcontrollers. No install — open the page in **Chrome** or **Edge**, connect over USB, and read/write serial data.

## Use locally

Serve the folder over HTTP (Web Serial needs a secure context):

```bash
npx --yes serve .
```

Then open the URL shown (usually `http://localhost:3000`).

Or push to GitHub and enable **Pages** (Deploy from branch → `/` root).

## Features

- Connect / disconnect via Web Serial API
- Baud rate selection
- Timestamps, hex view, auto-scroll
- Send with NL / CR / CRLF / none
- Clear log and export `.txt`
- Auto-reconnect when the cable is unplugged briefly

## Notes

- Desktop Chrome or Edge only (not Firefox/Safari; limited mobile support)
- Page must be HTTPS (GitHub Pages) or `localhost`
- Match the baud rate to your sketch (`Serial.begin(...)`)
