/**
 * Serial Bench — Web Serial monitor for Arduino / MCU testing.
 * Host on GitHub Pages (HTTPS). Requires Chrome or Edge on desktop.
 */

const $ = (id) => document.getElementById(id);

const els = {
  connectBtn: $("connectBtn"),
  disconnectBtn: $("disconnectBtn"),
  sendBtn: $("sendBtn"),
  clearBtn: $("clearBtn"),
  exportBtn: $("exportBtn"),
  baudRate: $("baudRate"),
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
let reconnectTimer = null;
let reconnectAttempt = 0;
let intentionalClose = false;
/** @type {{ usbVendorId?: number, usbProductId?: number } | null} */
let lastPortInfo = null;

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

function timestamp() {
  const d = new Date();
  return (
    d.toLocaleTimeString(undefined, { hour12: false }) +
    "." +
    String(d.getMilliseconds()).padStart(3, "0")
  );
}

function appendLine(kind, text) {
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

  if (els.autoScroll.checked) {
    els.output.scrollTop = els.output.scrollHeight;
  }
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

async function openPort(selectedPort) {
  const baudRate = Number(els.baudRate.value);
  await selectedPort.open({ baudRate });
  port = selectedPort;
  intentionalClose = false;
  reconnectAttempt = 0;
  textDecoder = new TextDecoder();
  clearReconnectTimer();

  const info = port.getInfo?.() ?? {};
  lastPortInfo = info;
  els.portInfo.textContent = formatPortLabel(baudRate, info);

  setConnectedUi(true);
  setStatus("connected", "Connected");
  appendLine("sys", `Port opened at ${baudRate} baud`);

  port.addEventListener("disconnect", onPortDisconnect);

  if (port.writable) {
    writer = port.writable.getWriter();
  }

  keepReading = true;
  readPromise = readLoop();
}

async function readLoop() {
  if (!port?.readable) return;

  reader = port.readable.getReader();

  try {
    while (keepReading) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.length) continue;

      totalBytes += value.length;
      updateByteCount();

      if (els.hexMode.checked) {
        appendLine("hex", bytesToHex(value));
      } else {
        const text = textDecoder.decode(value, { stream: true });
        if (text) {
          appendLine("rx", text.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
        }
      }
    }
  } catch (err) {
    if (keepReading && !intentionalClose) {
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
}

function onPortDisconnect() {
  if (intentionalClose) return;

  appendLine("sys", "Device disconnected");
  setConnectedUi(false);
  setStatus("error", "Disconnected");
  els.portInfo.textContent = "Port lost";

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
    els.sendInput.focus();
  } catch (err) {
    if (err?.name === "NotFoundError") {
      appendLine("sys", "No port selected");
      return;
    }
    setStatus("error", "Connect failed");
    appendLine("sys", `Connect error: ${err.message || err}`);
  }
}

async function disconnect() {
  intentionalClose = true;
  clearReconnectTimer();
  keepReading = false;

  if (port) {
    port.removeEventListener("disconnect", onPortDisconnect);
  }

  await closePortQuietly();
  port = null;

  setConnectedUi(false);
  setStatus("idle", "Disconnected");
  els.portInfo.textContent = "No port selected";
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
  totalBytes = 0;
  updateByteCount();
}

function exportLog() {
  const text = els.output.innerText || "";
  if (!text.trim()) {
    appendLine("sys", "Nothing to export");
    return;
  }

  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  a.href = url;
  a.download = `serial-bench-${stamp}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

function showCompat() {
  els.compatHint.hidden = false;
  els.compatHint.textContent =
    "Web Serial is not available in this browser. Open this page in Chrome or Edge on a desktop PC (HTTPS or localhost).";
  els.connectBtn.disabled = true;
  setStatus("error", "Unsupported browser");
}

function wireEvents() {
  els.connectBtn.addEventListener("click", connect);
  els.disconnectBtn.addEventListener("click", disconnect);
  els.sendBtn.addEventListener("click", send);
  els.clearBtn.addEventListener("click", clearLog);
  els.exportBtn.addEventListener("click", exportLog);

  els.sendInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  els.hexMode.addEventListener("change", () => {
    appendLine(
      "sys",
      els.hexMode.checked
        ? "Hex view enabled (new data shown as hex)"
        : "Text view enabled"
    );
  });
}

async function init() {
  wireEvents();

  if (!supportsSerial()) {
    showCompat();
    return;
  }

  setStatus("idle", "Disconnected");
  appendLine("sys", "Ready. Click Connect and choose your Arduino / serial device.");

  try {
    const ports = await navigator.serial.getPorts();
    if (ports.length) {
      appendLine(
        "sys",
        `${ports.length} previously allowed port(s) available — click Connect to use one.`
      );
    }
  } catch {
    /* ignore */
  }

  navigator.serial.addEventListener("connect", () => {
    if (!port && els.autoReconnect.checked && !intentionalClose) {
      appendLine("sys", "Serial device plugged in");
      tryReconnect();
    }
  });
}

init();
