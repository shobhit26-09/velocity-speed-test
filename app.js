/* Velocity — speed test engine. Real measurements via Cloudflare's open speed endpoints. */
(function () {
  "use strict";

  var CF = "https://speed.cloudflare.com";
  var PING_SAMPLES = 12;
  var DOWNLOAD_SECONDS = 9;
  var UPLOAD_SECONDS = 9;
  var DOWNLOAD_STREAMS = 4;
  var UPLOAD_STREAMS = 2;
  var GAUGE_MAX = 1000; // Mbps, log scale ceiling

  // ---------- DOM ----------
  var $ = function (id) { return document.getElementById(id); };
  var goBtn = $("go-btn"), againBtn = $("again-btn");
  var liveReadout = $("live-readout"), liveValue = $("live-value"), livePhase = $("live-phase");
  var arc = $("arc"), arcDot = $("arc-dot");
  var substats = $("substats"), results = $("results"), conn = $("conn");
  var headerMeta = $("header-meta");
  var warp = window.VelocityWarp || { setSpeed: function () {} };

  // ---------- Gauge ----------
  var CX = 170, CY = 170, R = 132, START_DEG = 135, SWEEP_DEG = 270;
  var TICKS = [0, 1, 5, 10, 25, 50, 100, 250, 500, 1000];

  function frac(v) { // value -> fraction of full scale [0..1]
    if (v <= 0) return 0;
    var f = Math.log10(1 + v) / Math.log10(1 + GAUGE_MAX);
    return Math.min(1, f);
  }
  function pointAt(f) { // f = fraction of full scale [0..1]
    var a = (START_DEG + SWEEP_DEG * f) * Math.PI / 180;
    return [CX + R * Math.cos(a), CY + R * Math.sin(a)];
  }
  function buildTicks() {
    var g = $("ticks"), ns = "http://www.w3.org/2000/svg", i, f, p1, p2, line, lbl, tp;
    for (i = 0; i < TICKS.length; i++) {
      f = frac(TICKS[i]);
      var a = (START_DEG + SWEEP_DEG * f) * Math.PI / 180;
      var cos = Math.cos(a), sin = Math.sin(a);
      p1 = [CX + (R - 14) * cos, CY + (R - 14) * sin];
      p2 = [CX + (R - 6) * cos, CY + (R - 6) * sin];
      line = document.createElementNS(ns, "line");
      line.setAttribute("x1", p1[0]); line.setAttribute("y1", p1[1]);
      line.setAttribute("x2", p2[0]); line.setAttribute("y2", p2[1]);
      line.setAttribute("class", "tick");
      g.appendChild(line);
      if (TICKS[i] > 0) {
        tp = [CX + (R - 26) * cos, CY + (R - 26) * sin];
        lbl = document.createElementNS(ns, "text");
        lbl.setAttribute("x", tp[0]); lbl.setAttribute("y", tp[1] + 3);
        lbl.setAttribute("class", "tick-label");
        lbl.textContent = TICKS[i] >= 1000 ? "1G" : String(TICKS[i]);
        g.appendChild(lbl);
      }
    }
  }
  var displayed = 0, targetVal = 0, rafId = null;
  function animateGauge() {
    var diff = targetVal - displayed;
    if (Math.abs(diff) < 0.05) { displayed = targetVal; rafId = null; renderGauge(); return; }
    displayed += diff * 0.22;
    renderGauge();
    rafId = requestAnimationFrame(animateGauge);
  }
  function arcPath(f) {
 // Plain polyline from known centre/radius/angles: no arc commands, no measurement APIs.
 var n = Math.max(2, Math.ceil(f * 120)), k, ang, d = "";
 for (k = 0; k <= n; k++) {
 ang = (START_DEG + SWEEP_DEG * f * (k / n)) * Math.PI / 180;
 d += (k ? "L" : "M") + (CX + R * Math.cos(ang)).toFixed(2) + " " + (CY + R * Math.sin(ang)).toFixed(2);
 }
 return d;
 }
 function arcColor(f) { // green -> cyan -> blue, computed in JS (no SVG gradient)
 var h = 140 + (212 - 140) * f; // hue 140 (green) .. 212 (blue)
 return "hsl(" + h.toFixed(0) + ",85%,58%)";
 }
 function renderGauge() {
 var f = frac(displayed);
 var track = $("track");
 if (!track.getAttribute("d")) track.setAttribute("d", arcPath(1));
 arc.setAttribute("d", f > 0.002 ? arcPath(Math.min(f, 1)) : "");
 arc.setAttribute("stroke", arcColor(f));
 var p = pointAt(f);
 arcDot.setAttribute("cx", p[0]); arcDot.setAttribute("cy", p[1]);
 arcDot.setAttribute("opacity", displayed > 0.3 ? "1" : "0");
 liveValue.textContent = displayed < 10 ? displayed.toFixed(1) : Math.round(displayed);
 }
 function setGauge(v) {
    targetVal = v;
    if (!rafId) rafId = requestAnimationFrame(animateGauge);
  }

  // ---------- helpers ----------
  function now() { return performance.now(); }
  function fmtMbps(v) { return v >= 100 ? Math.round(v) : v >= 10 ? v.toFixed(1) : v.toFixed(2); }

  // Sliding-window throughput tracker
  function Throughput() {
    this.samples = []; // [t, cumulativeBytes]
    this.total = 0;
  }
  Throughput.prototype.add = function (bytes) {
    this.total += bytes;
    this.samples.push([now(), this.total]);
  };
  Throughput.prototype.windowMbps = function (windowMs) {
    var t = now(), cutoff = t - windowMs, s = this.samples;
    if (!s.length) return 0;
    var base = s[0];
    while (s.length > 2 && s[1][0] < cutoff) { base = s.shift(); }
    var dt = (t - base[0]) / 1000;
    if (dt <= 0.001) return 0;
    return ((this.total - base[1]) * 8) / dt / 1e6;
  };
  Throughput.prototype.overallMbps = function (warmupMs, startT) {
    // exclude ramp-up
    var s = this.samples;
    if (!s.length) return 0;
    var i, base = s[0], cutoff = startT + warmupMs;
    for (i = 0; i < s.length; i++) { if (s[i][0] <= cutoff) base = s[i]; else break; }
    var dt = (now() - Math.max(base[0], cutoff - 1)) / 1000;
    if (dt <= 0) dt = (now() - startT) / 1000;
    return ((this.total - base[1]) * 8) / dt / 1e6;
  };

  // ---------- measurement phases ----------
  var meta = { ip: null, colo: null, city: null, country: null, asn: null };

  function grabMeta(headers) {
    if (!headers) return;
    meta.ip = meta.ip || headers.get("cf-meta-ip");
    meta.colo = meta.colo || headers.get("cf-meta-colo");
    meta.city = meta.city || headers.get("cf-meta-city");
    meta.country = meta.country || headers.get("cf-meta-country");
    meta.asn = meta.asn || headers.get("cf-meta-asn");
  }

  async function measurePing() {
 // Warm-up requests absorb DNS/TLS/IPv6 connection setup so they don't count as latency.
 // Each sample has a hard timeout; stalled samples are dropped instead of poisoning jitter.
 var WARMUP = 3, TIMEOUT_MS = 2500, rtts = [], i, t0, resp, ctl, tm;
 for (i = 0; i < PING_SAMPLES + WARMUP; i++) {
 ctl = new AbortController();
 tm = setTimeout(function () { ctl.abort(); }, TIMEOUT_MS);
 t0 = now();
 try {
 resp = await fetch(CF + "/__down?bytes=0&r=" + Math.random(), { cache: "no-store", signal: ctl.signal });
 grabMeta(resp.headers);
 if (i >= WARMUP) rtts.push(now() - t0);
 } catch (e) { /* skip failed or timed-out sample */ }
 clearTimeout(tm);
 if (i === WARMUP + 2 && rtts.length) setSub("sub-ping", Math.round(Math.min.apply(null, rtts)) + " ms");
 }
 if (!rtts.length) throw new Error("ping failed");
 var ping = Math.min.apply(null, rtts);
 // Jitter = median absolute difference between consecutive samples (robust to one-off spikes).
 var sorted = rtts.slice().sort(function (x, y) { return x - y; });
 var med = sorted[Math.floor(sorted.length / 2)];
 var kept = rtts.filter(function (v) { return v <= med * 2; }); // ignore one-off spikes
 var diffs = [], j;
 for (j = 1; j < kept.length; j++) diffs.push(Math.abs(kept[j] - kept[j - 1]));
 var jitter = diffs.length ? diffs.reduce(function (p, q) { return p + q; }, 0) / diffs.length : 0;
  return { ping: ping, jitter: jitter };
 }

  async function measureDownload(onTick) {
    var tp = new Throughput();
    var startT = now();
    var deadline = startT + DOWNLOAD_SECONDS * 1000;
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, DOWNLOAD_SECONDS * 1000);

    async function stream(k) {
      var resp = await fetch(CF + "/__down?bytes=100000000&r=" + Math.random(), {
        cache: "no-store", signal: ctl.signal
      });
      if (k === 0) grabMeta(resp.headers);
      var reader = resp.body.getReader();
      for (;;) {
        var chunk = await reader.read();
        if (chunk.done) break;
        tp.add(chunk.value.byteLength);
        if (now() > deadline) { ctl.abort(); break; }
      }
    }

    var ui = setInterval(function () {
      onTick(tp.windowMbps(600));
      setSub("sub-down", fmtMbps(tp.windowMbps(1000)) + " Mbps");
    }, 100);

    var workers = [], i;
    for (i = 0; i < DOWNLOAD_STREAMS; i++) workers.push(stream(i));
    try { await Promise.all(workers); } catch (e) {
      if (!ctl.signal.aborted) { clearInterval(ui); clearTimeout(timer); throw e; }
    }
    clearInterval(ui); clearTimeout(timer);
    if (tp.total < 10000) throw new Error("download failed");
    return tp.overallMbps(600, startT);
  }

  function makeRandomBlob(mb) {
    var size = mb * 1024 * 1024;
    var buf = new Uint8Array(size);
    var CHUNK = 65536, off = 0;
    while (off < size) {
      var n = Math.min(CHUNK, size - off);
      crypto.getRandomValues(buf.subarray(off, off + n));
      off += n;
    }
    return buf;
  }

  async function measureUpload(onTick) {
    var tp = new Throughput();
    var startT = now();
    var deadline = startT + UPLOAD_SECONDS * 1000;
    var payload = makeRandomBlob(16); // one buffer, sliced per request
    var sizes = [1, 2, 4, 8, 12, 16]; // MB, progressive fallback

    var activeXhrs = [];
    function postOnce(sizeMb) {
      return new Promise(function (resolve, reject) {
        var bytes = sizeMb * 1024 * 1024;
        var body = new Blob([payload.subarray(0, bytes)]);
        var xhr = new XMLHttpRequest();
        var last = 0;
        activeXhrs.push(xhr);
        xhr.open("POST", CF + "/__up?r=" + Math.random(), true);
        xhr.upload.onprogress = function (ev) {
          tp.add(ev.loaded - last);
          last = ev.loaded;
        };
        xhr.onload = function () { resolve(); };
        xhr.onerror = function () { aborted ? resolve() : reject(new Error("upload xhr failed")); };
        xhr.onabort = function () { resolve(); };
        xhr.send(body);
      });
    }
    function abortInFlight() {
      for (var a = 0; a < activeXhrs.length; a++) { try { activeXhrs[a].abort(); } catch (e) {} }
    }

    var aborted = false;
    async function worker(k) {
      var idx = 0;
      while (now() < deadline && !aborted) {
        var sizeMb = sizes[Math.min(idx, sizes.length - 1)];
        await postOnce(sizeMb);
        idx++;
      }
    }

    var ui = setInterval(function () {
      onTick(tp.windowMbps(600));
      setSub("sub-up", fmtMbps(tp.windowMbps(1000)) + " Mbps");
      if (now() > deadline) { aborted = true; abortInFlight(); }
    }, 100);

    var workers = [], i;
    for (i = 0; i < UPLOAD_STREAMS; i++) workers.push(worker(i));
    try { await Promise.all(workers); } catch (e) { /* one stream failing mid-run is tolerated if we have data */ }
    clearInterval(ui);
    if (tp.total < 10000) throw new Error("upload failed");
    return tp.overallMbps(600, startT);
  }

  // ---------- ISP lookup (best effort) ----------
  async function lookupISP() {
    try {
      var resp = await fetch("https://ipapi.co/json/", { cache: "no-store" });
      if (!resp.ok) return null;
      var j = await resp.json();
      return j && j.org ? j.org : null;
    } catch (e) { return null; }
  }

  // ---------- UI ----------
  function setSub(id, v) { $(id).textContent = v; }
  function setHeader(t) { headerMeta.childNodes[headerMeta.childNodes.length - 1].textContent = t; }
  function setBusy(on) { headerMeta.classList.toggle("busy", on); }

  var PHASES = ["ping", "jitter", "download", "upload"];
  function phaseState(name, state) {
    var el = $("phase-" + name);
    if (!el) return;
    if (state === "active") { el.classList.add("active"); el.classList.remove("done"); }
    else if (state === "done") { el.classList.remove("active"); el.classList.add("done"); }
    else { el.classList.remove("active"); el.classList.remove("done"); }
  }
  function resetPhases() { PHASES.forEach(function (p) { phaseState(p, "idle"); }); }

  function countUp(el, finalVal, fmt, ms) {
    var t0 = now();
    function step() {
      var k = Math.min(1, (now() - t0) / ms);
      var eased = 1 - Math.pow(1 - k, 3);
      el.textContent = fmt(finalVal * eased);
      if (k < 1) requestAnimationFrame(step);
      else el.textContent = fmt(finalVal);
    }
    requestAnimationFrame(step);
  }

  var running = false;

  async function runTest() {
    if (running) return;
    running = true;
    goBtn.disabled = true;
    goBtn.hidden = true;
    results.hidden = true;
    liveReadout.hidden = false;
    substats.hidden = false;
    displayed = 0; targetVal = 0; renderGauge();
    setSub("sub-ping", "—"); setSub("sub-jitter", "—");
    setSub("sub-down", "—"); setSub("sub-up", "—");
    resetPhases();
    setBusy(true);

    try {
      // Phase 1: latency
      setPhase("Ping"); setHeader("Measuring latency…");
      phaseState("ping", "active"); phaseState("jitter", "active");
      var lat = await measurePing();
      setSub("sub-ping", Math.round(lat.ping) + " ms");
      setSub("sub-jitter", lat.jitter < 10 ? lat.jitter.toFixed(1) + " ms" : Math.round(lat.jitter) + " ms");
      phaseState("ping", "done"); phaseState("jitter", "done");

      // Phase 2: download
      setPhase("Download"); setHeader("Testing download…");
      phaseState("download", "active");
      var down = await measureDownload(function (live) { setGauge(live); warp.setSpeed(live); });
      phaseState("download", "done");

      // Phase 3: upload
      setPhase("Upload"); setHeader("Testing upload…");
      phaseState("upload", "active");
      var up = await measureUpload(function (live) { setGauge(live); warp.setSpeed(live); });
      phaseState("upload", "done");

      // Final: settle the gauge exactly on the download headline so it matches the results
      displayed = down; targetVal = down; renderGauge();
      warp.setSpeed(down);
      setPhase("Done");
      setHeader("Test complete");
      showResults(down, up, lat.ping, lat.jitter);
      saveResult(down, up, lat.ping, lat.jitter);
      fillConnection();
    } catch (e) {
      setPhase("Network error");
      setHeader("Could not reach the test server — check your connection and try again");
      liveReadout.hidden = true;
      goBtn.hidden = false;
      warp.setSpeed(null);
    }
    setBusy(false);
    goBtn.disabled = false;
    running = false;
  }

  function setPhase(t) { livePhase.textContent = t; }

  async function fillConnection() {
    var isp = await lookupISP();
    $("c-isp").textContent = isp || (meta.asn ? "AS" + meta.asn : "Unknown");
    $("c-ip").textContent = meta.ip || "—";
    var place = meta.city && meta.country ? meta.city + ", " + meta.country : meta.colo;
    $("c-server").textContent = place ? "Cloudflare edge — " + place : "Cloudflare edge (nearest)";
    conn.hidden = false;
  }

  // Preload connection info on first paint so it reads like a real tool, speedtest.net-style
  async function preloadMeta() {
    try {
      var resp = await fetch(CF + "/__down?bytes=0&r=" + Math.random(), { cache: "no-store" });
      grabMeta(resp.headers);
    } catch (e) {}
    fillConnection();
  }

  function computeVerdict(down, up, ping, jitter) {
 var level = 3; // 3 excellent, 2 good, 1 okay, 0 poor
 function cap(n) { if (n < level) level = n; }
 if (down < 100) cap(2); if (down < 25) cap(1); if (down < 8) cap(0);
 if (up < 20) cap(2); if (up < 5) cap(1); if (up < 1.5) cap(0);
 if (ping > 50) cap(2); if (ping > 100) cap(1); if (ping > 250) cap(0);
 if (jitter > 15) cap(2); if (jitter > 35) cap(1); if (jitter > 100) cap(0);
 var names = ["Poor", "Okay", "Good", "Excellent"];
 var ok = [], no = [];
 (down >= 25 ? ok : no).push("4K streaming");
 (up >= 3 && ping <= 150 && jitter <= 35 ? ok : no).push("video calls");
 (ping <= 60 && jitter <= 20 ? ok : no).push("online gaming");
 if (down >= 100) ok.push("big downloads");
 var line;
 if (!ok.length) line = "Basic browsing and email will work, but streaming and calls may struggle.";
 else {
 line = "Great for " + ok.join(", ").replace(/, ([^,]*)$/, " and $1") + ".";
 if (no.length && level < 3) line += " " + no[0].charAt(0).toUpperCase() + no[0].slice(1) + " may struggle.";
 }
 return { name: names[level], cls: names[level].toLowerCase(), line: line };
 }

 function showResults(down, up, ping, jitter) {
    substats.hidden = true;
    var fm = function (v) { return fmtMbps(v); };
    var fmPing = function (v) { return String(Math.round(v)); };
    var fmJitter = function (v) { return v < 10 ? v.toFixed(1) : String(Math.round(v)); };
    countUp($("headline-down"), down, fm, 1100);
    countUp($("r-down"), down, fm, 900);
    countUp($("r-up"), up, fm, 900);
    countUp($("r-ping"), ping, fmPing, 700);
    countUp($("r-jitter"), jitter, fmJitter, 700);
    var v = computeVerdict(down, up, ping, jitter);
    $("verdict-title").textContent = v.name + " connection";
    $("verdict-title").className = "verdict-title " + v.cls;
    $("verdict-line").textContent = v.line;
    results.hidden = false;
    results.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

 function showResults(down, up, ping, jitter) {
    substats.hidden = true;
    var fm = function (v) { return fmtMbps(v); };
    var fmPing = function (v) { return String(Math.round(v)); };
    var fmJitter = function (v) { return v < 10 ? v.toFixed(1) : String(Math.round(v)); };
    countUp($("headline-down"), down, fm, 1100);
    countUp($("r-down"), down, fm, 900);
    countUp($("r-up"), up, fm, 900);
    countUp($("r-ping"), ping, fmPing, 700);
    countUp($("r-jitter"), jitter, fmJitter, 700);
    results.hidden = false;
    results.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // ---------- history ----------
  var HKEY = "velocity-history-v1";
  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HKEY)) || []; } catch (e) { return []; }
  }
  function saveResult(down, up, ping, jitter) {
    var h = loadHistory();
    h.unshift({ t: Date.now(), d: down, u: up, p: Math.round(ping) });
    h = h.slice(0, 5);
    try { localStorage.setItem(HKEY, JSON.stringify(h)); } catch (e) {}
    renderHistory();
  }
  function renderHistory() {
    var h = loadHistory();
    var list = $("history-list");
    list.innerHTML = "";
    if (!h.length) { $("history").hidden = true; return; }
    h.forEach(function (r) {
      var when = new Date(r.t);
      var label = when.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + ", " +
                  when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      var row = document.createElement("div");
      row.className = "history-item";
      row.innerHTML =
        '<span class="h-when">' + label + "</span>" +
        '<span class="h-val"><strong>' + fmtMbps(r.d) + "</strong><span>Mbps ↓</span></span>" +
        '<span class="h-val"><strong>' + fmtMbps(r.u) + "</strong><span>Mbps ↑</span></span>" +
        '<span class="h-val"><strong>' + r.p + "</strong><span>ms ping</span></span>";
      list.appendChild(row);
    });
    $("history").hidden = false;
  }

  // ---------- wire up ----------
  buildTicks();
  renderGauge();
  renderHistory();
  preloadMeta();
  goBtn.addEventListener("click", runTest);
  againBtn.addEventListener("click", function () {
    results.hidden = true;
    liveReadout.hidden = true;
    runTest();
  });
})();
