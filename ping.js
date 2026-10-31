import { createUdpTerminal } from "./udp.js?v=2";

const $ = (id) => document.getElementById(id);
const HELPER = "http://127.0.0.1:47831";
const KEY = "hardware-check-helper-key";
let token = "";
try { token = localStorage.getItem(KEY) || sessionStorage.getItem(KEY) || ""; } catch { /* Storage may be disabled. */ }
function consumePairingKey() {
  const fragmentKey = new URLSearchParams(location.hash.slice(1)).get("helper");
  const valid = fragmentKey && /^[A-Za-z0-9_-]{43}$/.test(fragmentKey);
  if (valid) {
    token = fragmentKey;
    try { localStorage.setItem(KEY, token); sessionStorage.setItem(KEY, token); } catch { /* In-memory pairing still works. */ }
  }
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  return valid;
}
consumePairingKey();

let ready = false;
let checking = false;
let active = false;
let stopRequested = false;
let wake = null;
let sent = 0, received = 0, lost = 0, totalMs = 0;
let minMs = Infinity, maxMs = 0;
let udpTerminal = null, supportsUdp = false;

function showHelper(connected, title, detail) {
  ready = connected;
  $("helperPill").dataset.state = connected ? "connected" : "idle";
  $("helperStatus").textContent = title;
  $("helperDetail").textContent = detail;
  document.querySelector(".ping-setup").dataset.connected = String(connected);
  $("startBtn").disabled = !connected || active;
  udpTerminal?.setHelperState(connected, supportsUdp);
}

async function request(path, body, options = {}) {
  const response = await fetch(HELPER + path, {
    method: body ? "POST" : "GET",
    mode: "cors",
    credentials: "omit",
    cache: "no-store",
    keepalive: Boolean(options.keepalive),
    targetAddressSpace: "loopback",
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(3500),
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || `Helper error (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function checkHelper() {
  if (checking || active) return;
  checking = true;
  $("checkHelperBtn").disabled = true;
  try {
    const data = await request("/health");
    if (data.service !== "hardware-check-helper" || !["1.0.0", "1.1.0", "1.2.0", "1.3.0"].includes(data.version)) {
      throw new Error("Unexpected helper version. Download the current helper.");
    }
    supportsUdp = data.capabilities?.includes("udp-broadcast") === true;
    if (data.paired === true) {
      showHelper(true, "Helper connected — ready to ping", "Connected to this laptop. Enter a device IP and start the test.");
    } else {
      showHelper(false, "Helper found — pairing needed", "Press Open installed helper to pair this browser automatically. If you use the older portable helper, open its private link instead.");
    }
  } catch {
    showHelper(false, "Helper unavailable", "First time here? Install the helper below once. Already installed? Press Open installed helper. Allow local network / loopback access if your browser asks; this page will connect automatically.");
  } finally {
    checking = false;
    $("checkHelperBtn").disabled = false;
  }
}

function validLocalIP(value) {
  if (!/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(value)) return false;
  const [a, b, c, d] = value.split(".").map(Number);
  return [a, b, c, d].every((n) => n <= 255) &&
    (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 169 && b === 254));
}

function renderStats() {
  $("sent").textContent = sent.toLocaleString();
  $("received").textContent = received.toLocaleString();
  $("lost").textContent = lost.toLocaleString();
  $("loss").textContent = `${sent ? ((lost / sent) * 100).toFixed(1) : 0}%`;
  $("minMs").textContent = received ? `${minMs} ms` : "—";
  $("avgMs").textContent = received ? `${(totalMs / received).toFixed(1)} ms` : "—";
  $("maxMs").textContent = received ? `${maxMs} ms` : "—";
}

function waitForNext(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { wake = null; resolve(); }, milliseconds);
    wake = () => { clearTimeout(timer); wake = null; resolve(); };
  });
}

function recordReply(data, ip) {
  if (data.ip !== ip || typeof data.ok !== "boolean" ||
      (data.ok && (!Number.isFinite(data.ms) || data.ms < 0))) {
    throw new Error("The helper returned an invalid ping result.");
  }
  sent += 1;
  if (data.ok) {
    received += 1;
    totalMs += data.ms;
    minMs = Math.min(minMs, data.ms);
    maxMs = Math.max(maxMs, data.ms);
  } else lost += 1;
  $("lastMs").textContent = data.ok ? String(data.ms) : "—";
  $("testStatus").textContent = data.ok ? "Device is replying" : "No reply";
  $("testDetail").textContent = data.ok ? `Reply from ${ip}${Number.isInteger(data.ttl) ? ` · TTL ${data.ttl}` : ""}` : `${ip} · ${data.message || "Request timed out"}`;
  $("emptyReplies")?.remove();
  const row = document.createElement("tr");
  row.dataset.ok = String(data.ok);
  for (const value of [new Date().toLocaleTimeString([], { hour12: false }), ip,
    data.ok ? "Reply received" : data.message || "Request timed out", data.ok ? `${data.ms} ms` : "—"]) {
    const cell = document.createElement("td");
    cell.textContent = value;
    row.appendChild(cell);
  }
  $("replyRows").prepend(row);
  while ($("replyRows").children.length > 100) $("replyRows").lastElementChild.remove();
  renderStats();
}

async function start(event) {
  event.preventDefault();
  if (active || !ready) return;
  const ip = $("ipAddress").value.trim();
  if (!validLocalIP(ip)) {
    $("ipError").hidden = false;
    $("ipError").textContent = "Enter a local IPv4 address, such as 192.168.1.20 (private LAN, link-local, or loopback).";
    $("ipAddress").setAttribute("aria-invalid", "true");
    $("ipAddress").focus();
    return;
  }
  $("ipAddress").removeAttribute("aria-invalid");
  $("ipError").hidden = true;
  active = true;
  stopRequested = false;
  sent = received = lost = totalMs = maxMs = 0;
  minMs = Infinity;
  $("replyRows").replaceChildren();
  $("lastMs").textContent = "—";
  renderStats();
  $("startBtn").disabled = true;
  $("stopBtn").disabled = false;
  $("ipAddress").disabled = true;
  $("testStatus").textContent = "Pinging device…";
  $("testDetail").textContent = ip;
  let failed = false;
  try {
    while (!stopRequested) {
      const started = performance.now();
      let data;
      try {
        data = await request("/ping", { ip });
      } catch (error) {
        if (error.status !== 429) throw error;
        $("testStatus").textContent = "Waiting for helper…";
        $("testDetail").textContent = "Another ping is finishing on this laptop.";
        if (!stopRequested) await waitForNext(1000);
        continue;
      }
      recordReply(data, ip);
      if (!stopRequested) await waitForNext(Math.max(0, 1000 - (performance.now() - started)));
    }
  } catch (error) {
    failed = true;
    showHelper(false, "Helper connection interrupted", "Keep the helper open. Use Check helper again, or reopen its paired page if you restarted it.");
    $("testStatus").textContent = "Test interrupted";
    $("testDetail").textContent = error.message === "Failed to fetch" ? "The helper could not be reached. Check the helper and browser permissions." : error.message;
  } finally {
    active = false;
    $("startBtn").disabled = !ready;
    $("stopBtn").disabled = true;
    $("ipAddress").disabled = false;
    if (!failed) {
      $("testStatus").textContent = "Test stopped";
      $("testDetail").textContent = `${ip} · ${sent} packets completed. Start again for a new test.`;
    }
  }
}

$("pingForm").addEventListener("submit", start);
$("stopBtn").addEventListener("click", () => {
  stopRequested = true;
  $("stopBtn").disabled = true;
  $("testStatus").textContent = "Stopping…";
  wake?.();
});
$("checkHelperBtn").addEventListener("click", checkHelper);
udpTerminal = createUdpTerminal({ request, validLocalIP });
// Opening a paired link can reuse an existing tab without reloading its scripts.
window.addEventListener("hashchange", () => {
  if (consumePairingKey()) checkHelper();
});
checkHelper();
setInterval(checkHelper, 5000);
