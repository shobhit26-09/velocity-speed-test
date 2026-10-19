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
  function renderGauge() {
    var f = frac(displayed);
    arc.setAttribute("stroke-dasharray", (f * 75) + " 100");
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
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
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
    var t = now(), cutoff = t - windowMs, s = this.samples, base = s[0];
    while (s.length > 2 && s[1][0] < cutoff) { base = s.shift(); }
    var dt = (t - base[0]) / 1000;
    if (dt <= 0.001) return 0;
    return ((this.total - base[1]) * 8) / dt / 1e6;
  };
  Throughput.prototype.overallMbps = function (warmupMs, startT) {
    // exclude ramp-up
    var s = this.samples, i, base = s[0], cutoff = startT + warmupMs;
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
    var rtts = [], i, t0, resp;
    for (i = 0; i < PING_SAMPLES; i++) {
      t0 = now();
      try {
        resp = await fetch(CF + "/__down?bytes=0&r=" + Math.random(), { cache: "no-store" });
        grabMeta(resp.headers);
        rtts.push(now() - t0);
      } catch (e) { /* skip failed sample */ }
      if (i === 2) setSub("sub-ping", Math.round(Math.min.apply(null, rtts)) + " ms");
    }
    if (!rtts.length) throw new Error("ping failed");
    var ping = Math.min.apply(null, rtts);
    var diffs = [], j;
    for (j = 1; j < rtts.length; j++) diffs.push(Math.abs(rtts[j] - rtts[j - 1]));
    var jitter = diffs.length ? diffs.reduce(function (a, b) { return a + b; }, 0) / diffs.length : 0;
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
  function setPhase(t) { livePhase.textContent = t; }
  function setHeader(t) { headerMeta.textContent = t; }

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

    try {
      // Phase 1: latency
      setPhase("Ping"); setHeader("Measuring latency…");
      var lat = await measurePing();
      setSub("sub-ping", Math.round(lat.ping) + " ms");
      setSub("sub-jitter", lat.jitter < 10 ? lat.jitter.toFixed(1) + " ms" : Math.round(lat.jitter) + " ms");

      // Phase 2: download
      setPhase("Download"); setHeader("Testing download…");
      var down = await measureDownload(function (live) { setGauge(live); });

      // Phase 3: upload
      setPhase("Upload"); setHeader("Testing upload…");
      var up = await measureUpload(function (live) { setGauge(live); });

      // Final: leave gauge on download headline
      setGauge(down);
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
    }
    goBtn.disabled = false;
    running = false;
  }

  async function fillConnection() {
    var isp = await lookupISP();
    $("c-isp").textContent = isp || (meta.asn ? "AS" + meta.asn : "Unknown");
    $("c-ip").textContent = meta.ip || "—";
    var place = meta.city && meta.country ? meta.city + ", " + meta.country : (meta.colo || "—");
    $("c-server").textContent = "Cloudflare edge — " + place;
    conn.hidden = false;
  }

  function showResults(down, up, ping, jitter) {
    substats.hidden = true;
    $("r-down").textContent = fmtMbps(down);
    $("r-up").textContent = fmtMbps(up);
    $("r-ping").textContent = Math.round(ping);
    $("r-jitter").textContent = jitter < 10 ? jitter.toFixed(1) : Math.round(jitter);
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
  goBtn.addEventListener("click", runTest);
  againBtn.addEventListener("click", function () {
    results.hidden = true;
    liveReadout.hidden = true;
    runTest();
  });
})();
