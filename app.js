/**
 * Hardware Check — Web Serial test page for non-technical users.
 * Host on GitHub Pages (HTTPS). Requires Chrome or Edge on desktop.
 *
 * Share link options for technicians:
 *   ?baud=115200&expect=FLAP
 */

const $ = (id) => document.getElementById(id);

const els = {
  connectBtn: $("connectBtn"),
  disconnectBtn: $("disconnectBtn"),
  sendBtn: $("sendBtn"),
  clearBtn: $("clearBtn"),
  exportBtn: $("exportBtn"),
  screenshotBtn: $("screenshotBtn"),
  copyReportBtn: $("copyReportBtn"),
  pauseBtn: $("pauseBtn"),
  latestOnly: $("latestOnly"),
  latestPanel: $("latestPanel"),
  latestValue: $("latestValue"),
  latestMeta: $("latestMeta"),
  workspace: $("workspace"),
  workspaceMain: document.querySelector(".workspace-main"),
  sidebarOpenBtn: $("sidebarOpenBtn"),
  sidebarCloseBtn: $("sidebarCloseBtn"),
  baudRate: $("baudRate"),
  expectText: $("expectText"),
  lineEnding: $("lineEnding"),
  sendInput: $("sendInput"),
  output: $("output"),
  statusPill: $("statusPill"),
  statusText: $("statusText"),
  portInfo: $("portInfo"),
  byteCount: $("byteCount"),
  timestamps: $("timestamps"),
  hexMode: $("hexMode"),
  autoScroll: $("autoScroll"),
  autoReconnect: $("autoReconnect"),
  compatHint: $("compatHint"),
  resultCard: $("resultCard"),
  resultLabel: $("resultLabel"),
  resultDetail: $("resultDetail"),
};

/** @type {SerialPort | null} */
let port = null;
/** @type {ReadableStreamDefaultReader<Uint8Array> | null} */
let reader = null;
/** @type {WritableStreamDefaultWriter<Uint8Array> | null} */
let writer = null;

let keepReading = false;
let readPromise = null;
let totalBytes = 0;
/**
 * Chrome's Web Serial default buffer is 255 bytes. An FTDI adapter
 * (VID 0x0403) delivers ESP32 boot text in bigger chunks, so the stream
 * errors with "Buffer overrun". Arduino IDE uses a much larger OS buffer.
 */
const SERIAL_BUFFER_SIZE = 1024 * 1024;
const MAX_DOM_LINES = 500;
/** Bytes waiting to be painted. Copied out of the read() chunk before the next read. */
let pendingRx = [];
let rxPaint = 0;
let overrunLogCount = 0;
let reconnectTimer = null;
let reconnectAttempt = 0;
let intentionalClose = false;
let rxBuffer = "";
/** @type {{ usbVendorId?: number, usbProductId?: number } | null} */
let lastPortInfo = null;

/** @type {"idle"|"waiting"|"working"|"matched"|"nodata"|"error"} */
let healthState = "idle";
let receivedAnyData = false;
let matchedExpect = false;
let noDataTimer = null;
const NO_DATA_MS = 8000;
let displayPaused = false;
/** Ring buffer for export/report when the live log is paused or latest-only. */
const logBuffer = [];
const MAX_LOG_BUFFER = 3000;
let latestLineCount = 0;

const textEncoder = new TextEncoder();
/** @type {TextDecoder} */
let textDecoder = new TextDecoder();
const LINE_ENDINGS = {
  nl: "\n",
  cr: "\r",
  crlf: "\r\n",
  none: "",
};

function supportsSerial() {
  return "serial" in navigator;
}

function setStatus(state, text) {
  els.statusPill.dataset.state = state;
  els.statusText.textContent = text;
}

function setConnectedUi(connected) {
  els.connectBtn.disabled = connected;
  els.disconnectBtn.disabled = !connected;
  els.sendBtn.disabled = !connected;
  els.sendInput.disabled = !connected;
  els.baudRate.disabled = connected;
}

function setHealth(state, label, detail) {
  healthState = state;
  els.resultCard.dataset.result = state;
  els.resultLabel.textContent = label;
  els.resultDetail.textContent = detail;
}

function clearNoDataTimer() {
  if (noDataTimer !== null) {
    clearTimeout(noDataTimer);
    noDataTimer = null;
  }
}

function startWaitingForData() {
  receivedAnyData = false;
  matchedExpect = false;
  clearNoDataTimer();
  setHealth(
    "waiting",
    "Connected — waiting for data…",
    "Leave the cable plugged in. If the device is healthy, messages should appear below within a few seconds."
  );
  setStatus("connected", "Connected — waiting");

  noDataTimer = setTimeout(() => {
    if (!port || receivedAnyData) return;
    setHealth(
      "nodata",
      "Connected, but no data yet",
      "Cable may be fine, but the device is not sending. Check power, baud rate (Advanced), or send a Copy report / screenshot to support."
    );
    setStatus("reconnecting", "No data yet");
  }, NO_DATA_MS);
}

function getExpectNeedle() {
  return (els.expectText.value || "").trim().toLowerCase();
}

function onSerialLine(line) {
  if (!line && line !== "") return;

  if (!receivedAnyData) {
    receivedAnyData = true;
    clearNoDataTimer();
  }

  const needle = getExpectNeedle();
  if (needle && line.toLowerCase().includes(needle)) {
    matchedExpect = true;
  }

  if (matchedExpect) {
    setHealth(
      "matched",
      "Device working",
      `Received the expected signal (“${els.expectText.value.trim()}”). You can disconnect and tell support it passed.`
    );
    setStatus("connected", "Working");
  } else if (receivedAnyData) {
    setHealth(
      "working",
      "Device is responding",
      needle
        ? `Data is arriving, but the expected text “${els.expectText.value.trim()}” was not seen yet.`
        : "The device is sending data over USB — hardware link looks good."
    );
    setStatus("connected", "Responding");
  }
}

function ingestText(chunk) {
  if (!chunk) return;

  rxBuffer += chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const parts = rxBuffer.split("\n");
  rxBuffer = parts.pop() ?? "";

  for (const line of parts) {
    appendLine("rx", line);
    onSerialLine(line);
  }
}

function flushRxBuffer() {
  if (!rxBuffer) return;
  const leftover = rxBuffer;
  rxBuffer = "";
  appendLine("rx", leftover);
  onSerialLine(leftover);
}

function clearRxBuffer() {
  rxBuffer = "";
}

function timestamp() {
  const d = new Date();
  return (
    d.toLocaleTimeString(undefined, { hour12: false }) +
    "." +
    String(d.getMilliseconds()).padStart(3, "0")
  );
}

function pushLogBuffer(lineText) {
  logBuffer.push(lineText);
  if (logBuffer.length > MAX_LOG_BUFFER) {
    logBuffer.splice(0, logBuffer.length - MAX_LOG_BUFFER);
  }
}

function setSidebarOpen(open) {
  els.workspace.dataset.sidebar = open ? "open" : "closed";
  els.sidebarOpenBtn.setAttribute("aria-expanded", open ? "true" : "false");
  els.sidebarOpenBtn.hidden = open;
}

function setPaused(paused) {
  displayPaused = paused;
  els.pauseBtn.setAttribute("aria-pressed", paused ? "true" : "false");
  els.pauseBtn.textContent = paused ? "Resume" : "Pause";
  appendLine(
    "sys",
    paused
      ? "Display paused — incoming data is still counted, screen is frozen"
      : "Display resumed"
  );
  syncLatestMode();
}

function syncLatestMode() {
  const on = els.latestOnly.checked;
  els.latestPanel.hidden = !on;
  els.workspaceMain.classList.toggle("latest-mode", on);
  if (on) {
    els.latestMeta.textContent = displayPaused
      ? "Paused — latest value frozen"
      : "Showing only the newest line (good for continuous sensors)";
  }
}

function updateLatestDisplay(text) {
  if (displayPaused) return;
  latestLineCount += 1;
  els.latestValue.textContent = text || "—";
  els.latestMeta.textContent = `Updated ${timestamp()} · ${latestLineCount.toLocaleString()} readings`;
}

function appendLine(kind, text) {
  const stamp = els.timestamps.checked ? `[${timestamp()}] ` : "";
  const plain = `${stamp}${text}`;
  pushLogBuffer(plain);

  const isData = kind === "rx" || kind === "hex";

  if (isData && els.latestOnly.checked) {
    updateLatestDisplay(text);
  }

  // Freeze the visible log (and latest) while paused — still keep buffer + health updates.
  if (displayPaused && isData) {
    return;
  }

  // Latest-only: skip flooding the scrolling log with sensor lines.
  if (els.latestOnly.checked && isData) {
    return;
  }

  const line = document.createElement("div");
  line.className = `line ${kind}`;

  if (els.timestamps.checked) {
    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = `[${timestamp()}]`;
    line.appendChild(ts);
  }

  const body = document.createElement("span");
  body.className = kind;
  body.textContent = text;
  line.appendChild(body);

  els.output.appendChild(line);
  trimOutput();

  if (els.autoScroll.checked) {
    els.output.scrollTop = els.output.scrollHeight;
  }
}

function trimOutput() {
  const extra = els.output.childElementCount - MAX_DOM_LINES;
  if (extra <= 0) return;
  const range = document.createRange();
  range.setStart(els.output, 0);
  range.setEnd(els.output, extra);
  range.deleteContents();
}

function isBufferOverrun(err) {
  const name = String(err?.name || "");
  const msg = String(err?.message || err || "");
  return name === "BufferOverrunError" || /buffer overrun/i.test(msg);
}

function noteOverrun() {
  overrunLogCount += 1;
  if (overrunLogCount === 1) {
    appendLine(
      "sys",
      "Buffer overrun — kept reading (a few bytes at that moment may be missing)"
    );
  } else if (overrunLogCount === 8) {
    appendLine(
      "sys",
      "Repeated buffer overruns — turn on Latest only so the screen can keep up"
    );
  }
}

function noteRx(value) {
  pendingRx.push(new Uint8Array(value));
  totalBytes += value.length;
  if (!rxPaint) rxPaint = requestAnimationFrame(paintRx);
}

function paintRx() {
  rxPaint = 0;
  const chunks = pendingRx;
  pendingRx = [];
  updateByteCount();
  if (!chunks.length) return;

  if (els.hexMode.checked) {
    for (const chunk of chunks) {
      const hex = bytesToHex(chunk);
      appendLine("hex", hex);
      onSerialLine(hex);
    }
    return;
  }

  let text = "";
  for (const chunk of chunks) {
    text += textDecoder.decode(chunk, { stream: true });
  }
  ingestText(text);
}

function flushPendingRxSync() {
  if (rxPaint) {
    cancelAnimationFrame(rxPaint);
    rxPaint = 0;
  }
  if (pendingRx.length) paintRx();
}

function updateByteCount() {
  els.byteCount.textContent =
    totalBytes === 1 ? "1 byte" : `${totalBytes.toLocaleString()} bytes`;
}

function bytesToHex(bytes) {
  const parts = [];
  for (let i = 0; i < bytes.length; i++) {
    parts.push(bytes[i].toString(16).padStart(2, "0").toUpperCase());
  }
  return parts.join(" ");
}

function clearReconnectTimer() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

async function releaseStreams() {
  keepReading = false;

  try {
    await reader?.cancel();
  } catch {
    /* ignore */
  }
  try {
    reader?.releaseLock();
  } catch {
    /* ignore */
  }
  reader = null;

  try {
    await writer?.close();
  } catch {
    /* ignore */
  }
  try {
    writer?.releaseLock();
  } catch {
    /* ignore */
  }
  writer = null;

  if (readPromise) {
    try {
      await readPromise;
    } catch {
      /* ignore */
    }
    readPromise = null;
  }
}

async function closePortQuietly() {
  await releaseStreams();
  if (port) {
    try {
      await port.close();
    } catch {
      /* already closed */
    }
  }
}

function formatPortLabel(baudRate, info) {
  const vid = info.usbVendorId
    ? `0x${info.usbVendorId.toString(16).padStart(4, "0")}`
    : "?";
  const pid = info.usbProductId
    ? `0x${info.usbProductId.toString(16).padStart(4, "0")}`
    : "?";
  return `Connected · ${baudRate} baud · VID ${vid} PID ${pid}`;
}

/**
 * Another app (Arduino IDE, PuTTY, another browser tab, etc.) often locks the COM port.
 * Web Serial then fails open() with NetworkError / "Failed to open serial port".
 */
function isPortBusyError(err) {
  const name = String(err?.name || "");
  const msg = String(err?.message || err || "").toLowerCase();

  if (name === "NetworkError" || name === "InvalidStateError") return true;

  return (
    msg.includes("failed to open") ||
    msg.includes("access denied") ||
    msg.includes("access is denied") ||
    msg.includes("resource busy") ||
    msg.includes("device or resource busy") ||
    msg.includes("in use") ||
    msg.includes("already open") ||
    msg.includes("exclusive") ||
    msg.includes("permission denied")
  );
}

function showPortBusyWarning(err) {
  setStatus("error", "Port in use");
  setConnectedUi(false);
  els.portInfo.textContent = "Could not open device";
  setHealth(
    "error",
    "Device is busy in another program",
    "Close Arduino IDE Serial Monitor, PuTTY, or any other serial software using this USB port. Also close other browser tabs of this page. Then press Connect again."
  );
  appendLine(
    "sys",
    `Port busy / locked — close other serial software and retry. (${err?.message || err})`
  );
}

async function openPort(selectedPort) {
  const baudRate = Number(els.baudRate.value);

  try {
    await selectedPort.open({
      baudRate,
      bufferSize: SERIAL_BUFFER_SIZE,
      flowControl: "none",
    });
  } catch (err) {
    if (isPortBusyError(err)) {
      showPortBusyWarning(err);
    }
    throw err;
  }

  port = selectedPort;
  intentionalClose = false;
  reconnectAttempt = 0;
  overrunLogCount = 0;
  textDecoder = new TextDecoder();
  clearRxBuffer();
  pendingRx = [];
  if (rxPaint) {
    cancelAnimationFrame(rxPaint);
    rxPaint = 0;
  }
  clearReconnectTimer();

  const info = port.getInfo?.() ?? {};
  lastPortInfo = info;
  els.portInfo.textContent = formatPortLabel(baudRate, info);

  setConnectedUi(true);
  port.removeEventListener("disconnect", onPortDisconnect);
  port.addEventListener("disconnect", onPortDisconnect);

  if (port.writable) {
    writer = port.writable.getWriter();
  }

  // Start reading before painting the log. The default 255-byte pipe
  // overruns if DOM work runs first, and closing the port to "recover"
  // pulses DTR, which resets the ESP32 and repeats the burst.
  keepReading = true;
  readPromise = readLoop();

  appendLine(
    "sys",
    `Port opened at ${baudRate} baud (${Math.round(SERIAL_BUFFER_SIZE / 1024)} KB buffer)`
  );
  startWaitingForData();
}

async function readLoop() {
  try {
    while (keepReading && port?.readable) {
      reader = port.readable.getReader();
      let resume = false;
      try {
        while (keepReading) {
          const { value, done } = await reader.read();
          if (done) return;
          if (value?.length) noteRx(value);
        }
      } catch (err) {
        resume = keepReading && !intentionalClose && isBufferOverrun(err);
        if (resume) {
          noteOverrun();
        } else if (keepReading && !intentionalClose) {
          appendLine("sys", `Read error: ${err.message || err}`);
        }
      } finally {
        try {
          reader?.releaseLock();
        } catch {
          /* ignore */
        }
        reader = null;
      }
      if (!resume) break;
      if (overrunLogCount > 40) {
        appendLine("sys", "Stopped reading after repeated buffer overruns");
        break;
      }
      await new Promise((r) => setTimeout(r, overrunLogCount > 5 ? 20 : 0));
    }
  } finally {
    flushPendingRxSync();
    flushRxBuffer();
  }
}

function onPortDisconnect() {
  if (intentionalClose) return;

  appendLine("sys", "Device disconnected");
  clearNoDataTimer();
  setConnectedUi(false);
  setStatus("error", "Unplugged");
  els.portInfo.textContent = "Device unplugged";
  setHealth(
    "error",
    "Device unplugged",
    "Plug it back in and press Connect again, or send a Copy report / screenshot to support."
  );

  releaseStreams().then(() => {
    port = null;
    if (els.autoReconnect.checked) {
      scheduleReconnect();
    }
  });
}

function scheduleReconnect() {
  clearReconnectTimer();
  reconnectAttempt += 1;
  const delay = Math.min(1000 * 2 ** Math.min(reconnectAttempt - 1, 4), 16000);
  setStatus("reconnecting", `Reconnecting… (${reconnectAttempt})`);
  appendLine("sys", `Auto-reconnect in ${(delay / 1000).toFixed(1)}s…`);
  reconnectTimer = setTimeout(tryReconnect, delay);
}

async function tryReconnect() {
  if (!els.autoReconnect.checked || intentionalClose) return;

  try {
    const ports = await navigator.serial.getPorts();
    if (!ports.length) {
      scheduleReconnect();
      return;
    }

    let candidate = ports[0];
    if (lastPortInfo?.usbVendorId != null) {
      const match = ports.find((p) => {
        const info = p.getInfo?.() ?? {};
        return (
          info.usbVendorId === lastPortInfo.usbVendorId &&
          info.usbProductId === lastPortInfo.usbProductId
        );
      });
      if (match) candidate = match;
    }

    await openPort(candidate);
  } catch (err) {
    appendLine("sys", `Reconnect failed: ${err.message || err}`);
    scheduleReconnect();
  }
}

async function connect() {
  if (!supportsSerial()) {
    showCompat();
    return;
  }

  try {
    clearReconnectTimer();
    intentionalClose = false;
    const selected = await navigator.serial.requestPort();
    await openPort(selected);
  } catch (err) {
    if (err?.name === "NotFoundError") {
      appendLine("sys", "No device selected");
      setHealth(
        "idle",
        "No device selected",
        "Press Connect again and pick your device from the browser list."
      );
      return;
    }
    if (isPortBusyError(err)) {
      // openPort already showed the busy warning when open() failed
      if (els.resultCard.dataset.result !== "error") {
        showPortBusyWarning(err);
      }
      return;
    }
    setStatus("error", "Connect failed");
    setHealth(
      "error",
      "Could not connect",
      `${err.message || err}. If the Arduino IDE Serial Monitor is open, close it and try again.`
    );
    appendLine("sys", `Connect error: ${err.message || err}`);
  }
}

async function disconnect() {
  intentionalClose = true;
  clearReconnectTimer();
  clearNoDataTimer();
  keepReading = false;

  if (port) {
    port.removeEventListener("disconnect", onPortDisconnect);
  }

  await closePortQuietly();
  port = null;

  setConnectedUi(false);
  setStatus("idle", "Not connected");
  els.portInfo.textContent = "No device selected";
  setHealth(
    "idle",
    "Disconnected",
    "Press Connect device when you are ready to test again."
  );
  appendLine("sys", "Port closed");
}

async function send() {
  if (!writer) return;

  const ending = LINE_ENDINGS[els.lineEnding.value] ?? "\n";
  const payload = els.sendInput.value + ending;
  if (!payload) return;

  try {
    const bytes = textEncoder.encode(payload);
    await writer.write(bytes);
    totalBytes += bytes.length;
    updateByteCount();

    const display = els.hexMode.checked
      ? bytesToHex(bytes)
      : payload.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
    appendLine(els.hexMode.checked ? "hex" : "tx", `→ ${display}`);
    els.sendInput.value = "";
    els.sendInput.focus();
  } catch (err) {
    appendLine("sys", `Send error: ${err.message || err}`);
  }
}

function clearLog() {
  els.output.textContent = "";
  clearRxBuffer();
  logBuffer.length = 0;
  latestLineCount = 0;
  els.latestValue.textContent = "—";
  els.latestMeta.textContent = els.latestOnly.checked
    ? "Waiting for readings…"
    : "Turn on Latest only for continuous sensors";
  totalBytes = 0;
  updateByteCount();
}

function exportLog() {
  const text =
    logBuffer.length > 0 ? logBuffer.join("\n") : els.output.innerText || "";
  if (!text.trim()) {
    appendLine("sys", "Nothing to export");
    return;
  }

  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  a.href = url;
  a.download = `hardware-check-${stamp}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

function buildSupportReport() {
  const lines = [
    "Hardware Check report",
    `Time: ${new Date().toISOString()}`,
    `Page: ${location.href}`,
    `Result: ${els.resultLabel.textContent}`,
    `Detail: ${els.resultDetail.textContent}`,
    `Connection: ${els.statusText.textContent}`,
    `Port: ${els.portInfo.textContent}`,
    `Bytes: ${els.byteCount.textContent}`,
    `Baud: ${els.baudRate.value}`,
    `Expect: ${els.expectText.value.trim() || "(any data)"}`,
    `Browser: ${navigator.userAgent}`,
    "",
    "--- Log ---",
    logBuffer.length > 0 ? logBuffer.join("\n") : els.output.innerText || "(empty)",
  ];
  return lines.join("\n");
}

async function copyReport() {
  const report = buildSupportReport();
  try {
    await navigator.clipboard.writeText(report);
    appendLine("sys", "Support report copied — paste it to your technician");
  } catch {
    const blob = new Blob([report], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "hardware-check-report.txt";
    a.click();
    URL.revokeObjectURL(url);
    appendLine("sys", "Clipboard blocked — report downloaded as a file instead");
  }
}

function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Could not create PNG"));
    }, "image/png");
  });
}

function downloadPngBlob(blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  a.href = url;
  a.download = `hardware-check-${stamp}.png`;
  a.click();
  URL.revokeObjectURL(url);
}

async function copyPngToClipboard(blob) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("Clipboard images are not supported in this browser");
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

async function captureViaDisplayMedia() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("Display capture not available");
  }

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: false,
    preferCurrentTab: true,
    selfBrowserSurface: "include",
    systemAudio: "exclude",
  });

  const video = document.createElement("video");
  video.playsInline = true;
  video.muted = true;
  video.srcObject = stream;

  try {
    await video.play();
    if (!video.videoWidth) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("Capture timed out")), 8000);
        video.onloadedmetadata = () => {
          clearTimeout(t);
          resolve();
        };
      });
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    return canvasToPngBlob(canvas);
  } finally {
    stream.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
  }
}

async function captureViaHtml2Canvas() {
  const { default: html2canvas } = await import(
    "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/+esm"
  );

  document.documentElement.classList.add("capturing-screenshot");
  try {
    await new Promise((r) => requestAnimationFrame(r));

    const canvas = await html2canvas(document.body, {
      backgroundColor: "#e8eef2",
      scale: Math.min(window.devicePixelRatio || 1, 2),
      useCORS: true,
      logging: false,
      foreignObjectRendering: false,
      scrollX: 0,
      scrollY: -window.scrollY,
      windowWidth: document.documentElement.scrollWidth,
      windowHeight: document.documentElement.scrollHeight,
      onclone(clonedDoc) {
        clonedDoc.documentElement.classList.add("capturing-screenshot");
        clonedDoc.querySelectorAll(".top, .shell, .monitor, .foot, .hero-check").forEach((el) => {
          el.style.animation = "none";
          el.style.opacity = "1";
          el.style.transform = "none";
        });
      },
    });

    return canvasToPngBlob(canvas);
  } finally {
    document.documentElement.classList.remove("capturing-screenshot");
  }
}

async function screenshotToClipboard() {
  const btn = els.screenshotBtn;
  if (btn.dataset.busy === "1") return;

  btn.dataset.busy = "1";
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");

  try {
    let blob;
    try {
      blob = await Promise.race([
        captureViaHtml2Canvas(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Page capture timed out")), 15000)
        ),
      ]);
    } catch (domErr) {
      appendLine("sys", `Page capture failed (${domErr.message || domErr}). Trying tab capture…`);
      blob = await captureViaDisplayMedia();
    }

    try {
      await copyPngToClipboard(blob);
      appendLine("sys", "Screenshot copied — paste with Ctrl+V to send to support");
    } catch (clipErr) {
      downloadPngBlob(blob);
      appendLine(
        "sys",
        `Clipboard blocked (${clipErr.message || clipErr}). PNG downloaded instead.`
      );
    }
  } catch (err) {
    appendLine("sys", `Screenshot failed: ${err.message || err}`);
  } finally {
    btn.dataset.busy = "0";
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
  }
}

function showCompat() {
  els.compatHint.hidden = false;
  els.compatHint.textContent =
    "This check needs Chrome or Edge on a Windows/Mac computer (not a phone). Open this same link there, then plug in the device.";
  els.connectBtn.disabled = true;
  setStatus("error", "Wrong browser");
  setHealth(
    "error",
    "Please use Chrome or Edge on a computer",
    "Phones and Firefox/Safari cannot talk to USB serial devices from a web page."
  );
}

function applyUrlParams() {
  const params = new URLSearchParams(location.search);
  const baud = params.get("baud");
  const expect = params.get("expect");

  if (baud && [...els.baudRate.options].some((o) => o.value === baud)) {
    els.baudRate.value = baud;
  }
  if (expect) {
    els.expectText.value = expect;
  }
}

function wireEvents() {
  els.connectBtn.addEventListener("click", connect);
  els.disconnectBtn.addEventListener("click", disconnect);
  els.sendBtn.addEventListener("click", send);
  els.clearBtn.addEventListener("click", clearLog);
  els.exportBtn.addEventListener("click", exportLog);
  els.screenshotBtn.addEventListener("click", screenshotToClipboard);
  els.copyReportBtn.addEventListener("click", copyReport);

  els.pauseBtn.addEventListener("click", () => {
    setPaused(!displayPaused);
  });

  els.latestOnly.addEventListener("change", () => {
    syncLatestMode();
    appendLine(
      "sys",
      els.latestOnly.checked
        ? "Latest only on — continuous readings show as one live value"
        : "Latest only off — full scrolling log"
    );
  });

  els.sidebarOpenBtn.addEventListener("click", () => setSidebarOpen(true));
  els.sidebarCloseBtn.addEventListener("click", () => setSidebarOpen(false));

  els.sendInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  els.hexMode.addEventListener("change", () => {
    if (els.hexMode.checked) {
      flushRxBuffer();
      appendLine("sys", "Hex view enabled");
    } else {
      clearRxBuffer();
      appendLine("sys", "Text view enabled (lines buffered until newline)");
    }
  });

  els.expectText.addEventListener("change", () => {
    if (!port || !receivedAnyData) return;
    matchedExpect = false;
    const needle = getExpectNeedle();
    if (!needle) {
      setHealth(
        "working",
        "Device is responding",
        "The device is sending data over USB — hardware link looks good."
      );
      return;
    }
    setHealth(
      "working",
      "Device is responding",
      `Waiting for expected text “${els.expectText.value.trim()}”.`
    );
  });
}

async function init() {
  applyUrlParams();
  wireEvents();
  setSidebarOpen(false);
  syncLatestMode();

  if (!supportsSerial()) {
    showCompat();
    return;
  }

  setStatus("idle", "Not connected");
  setHealth(
    "idle",
    "Ready when you are",
    "Plug the device into USB, then press Connect. Use Chrome or Edge on a computer."
  );
  appendLine("sys", "Ready — press Connect device and choose your hardware.");
  appendLine("sys", "Tip: for continuous sensors, turn on Latest only (or Pause to freeze the screen).");

  try {
    const ports = await navigator.serial.getPorts();
    if (ports.length) {
      appendLine(
        "sys",
        `${ports.length} previously allowed device(s) available — press Connect to use one.`
      );
    }
  } catch {
    /* ignore */
  }

  navigator.serial.addEventListener("connect", () => {
    if (!port && els.autoReconnect.checked && !intentionalClose) {
      appendLine("sys", "USB device plugged in");
      tryReconnect();
    }
  });
}

init();
