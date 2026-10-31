const $ = (id) => document.getElementById(id);

export function createUdpTerminal({ request, validLocalIP }) {
  let available = false, busy = false, sending = false, session = null;
  let cursor = 0, timer = null, polling = false, sent = 0, received = 0;
  const history = [];

  function controls() {
    $("udpOpenBtn").disabled = !available || busy || Boolean(session);
    $("udpCloseBtn").disabled = !session || busy;
    $("udpSendBtn").disabled = !available || !session || busy || sending;
    $("udpCommand").disabled = !available || !session || busy;
    for (const id of ["udpIp", "udpRemotePort", "udpLocalPort"]) $(id).readOnly = Boolean(session) || busy;
    $("udpExportBtn").disabled = !history.length;
  }

  function error(message) {
    $("udpError").hidden = !message;
    $("udpError").textContent = message;
  }

  function eventText(event) {
    const stamp = new Date(event.time).toLocaleTimeString([], { hour12: false });
    const payload = $("udpHexView").checked && event.kind !== "sys" ? event.hex : event.text;
    return `[${stamp}] ${event.kind.toUpperCase()} ${event.ip}:${event.port} · ${event.bytes} bytes${event.truncated ? " (display truncated to 4096 bytes)" : ""}\n${payload || "(empty datagram)"}`;
  }

  function paintEvent(event) {
    const row = document.createElement("div");
    row.className = event.kind;
    row.textContent = eventText(event);
    $("udpOutput").appendChild(row);
    while ($("udpOutput").children.length > 500) $("udpOutput").firstElementChild.remove();
  }

  function apply(data) {
    if (!session || data.session !== session) return;
    if (data.skipped) error(`${data.skipped} older terminal messages were skipped because the receive buffer filled.`);
    for (const event of data.events) {
      if (event.seq <= cursor) continue;
      history.push(event);
      paintEvent(event);
      cursor = event.seq;
    }
    while (history.length > 500) history.shift();
    sent = Math.max(sent, data.sent);
    received = Math.max(received, data.received);
    $("udpEndpoint").textContent = `Laptop ${data.localIp}:${data.localPort} · Device ${data.ip}:${data.remotePort} · TX ${sent} · RX ${received}`;
    if ($("udpAutoScroll").checked) $("udpOutput").scrollTop = $("udpOutput").scrollHeight;
    if (data.closed) {
      session = null;
      clearTimeout(timer);
      $("udpStatus").textContent = "UDP closed";
      if (data.error) error(data.error);
    }
    controls();
  }

  async function poll() {
    if (!session || polling) return;
    polling = true;
    const current = session;
    try {
      const data = await request("/udp/read", { session: current, after: cursor });
      if (session === current) apply(data);
    } catch (failure) {
      if (session === current) {
        session = null;
        $("udpStatus").textContent = "UDP interrupted";
        error(`${failure.message} Open UDP again to reconnect.`);
        controls();
      }
    } finally {
      polling = false;
      if (session) timer = setTimeout(poll, 300);
    }
  }

  $("udpOpenForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!available || busy || session) return;
    const ip = $("udpIp").value.trim();
    const remotePort = Number($("udpRemotePort").value);
    const localPort = Number($("udpLocalPort").value);
    if (!validLocalIP(ip)) { error("Enter your device’s local IPv4 address."); $("udpIp").focus(); return; }
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535 || !Number.isInteger(localPort) || localPort < 0 || localPort > 65535) {
      error("Enter a device port from 1 to 65535 and a receive port from 0 to 65535."); return;
    }
    busy = true;
    error("");
    controls();
    try {
      const data = await request("/udp/open", { ip, remotePort, localPort });
      session = data.session;
      cursor = sent = received = 0;
      history.length = 0;
      $("udpOutput").replaceChildren();
      $("udpStatus").textContent = "UDP open — listening";
      apply(data);
      poll();
    } catch (failure) { error(failure.message); }
    finally { busy = false; controls(); }
  });

  $("udpCloseBtn").addEventListener("click", async () => {
    if (!session || busy) return;
    busy = true;
    const current = session;
    clearTimeout(timer);
    controls();
    let confirmed = false;
    try { apply(await request("/udp/close", { session: current, after: cursor })); confirmed = true; }
    catch (failure) { error(`${failure.message} Closure could not be confirmed; the listener expires after two minutes without this page.`); }
    finally { session = null; busy = false; $("udpStatus").textContent = confirmed ? "UDP closed" : "UDP disconnected"; controls(); }
  });

  $("udpSendForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!session || busy || sending) return;
    const command = $("udpCommand").value;
    const current = session;
    sending = true;
    error("");
    controls();
    try {
      const data = await request("/udp/send", { session: current, after: cursor, data: command,
        encoding: $("udpEncoding").value, ending: $("udpEnding").value });
      if (session === current) {
        apply(data);
        if ($("udpCommand").value === command) $("udpCommand").value = "";
      }
    } catch (failure) { error(failure.message); }
    finally { sending = false; controls(); $("udpCommand").focus(); }
  });

  $("udpEncoding").addEventListener("change", () => {
    $("udpEnding").disabled = $("udpEncoding").value === "hex";
    $("udpCommand").placeholder = $("udpEncoding").value === "hex" ? "Byte pairs, for example 01 FF 0A" : "Enter your device command";
  });
  $("udpHexView").addEventListener("change", () => {
    $("udpOutput").replaceChildren();
    for (const event of history) paintEvent(event);
  });
  $("udpClearBtn").addEventListener("click", () => {
    history.length = 0;
    $("udpOutput").replaceChildren();
    error("");
    controls();
  });
  $("udpExportBtn").addEventListener("click", () => {
    const blob = new Blob([history.map(eventText).join("\n\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "hardware-check-udp-terminal.txt";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  window.addEventListener("pagehide", () => {
    clearTimeout(timer);
    if (session) request("/udp/close", { session }, { keepalive: true }).catch(() => {});
    session = null;
    $("udpStatus").textContent = "UDP closed";
    controls();
  });

  return {
    setHelperState(connected, supported) {
      available = connected && supported;
      $("udpUpgrade").hidden = !connected || supported;
      if (!session) $("udpStatus").textContent = available ? "Ready — enter device IP and ports" : connected ? "Update helper to use UDP" : "Connect the helper to use UDP";
      controls();
    },
  };
}
