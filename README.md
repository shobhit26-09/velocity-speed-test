# Velocity — Internet Speed Test

A fast, accurate, privacy-friendly internet speed test that runs entirely in the browser.

**Live:** https://velocity-speed.netlify.app

## What it measures

- **Download** — 4 parallel streams against Cloudflare's edge, sliding-window throughput
- **Upload** — progressive multipart uploads (XHR) with live throughput
- **Ping** — minimum RTT over 12 samples
- **Jitter** — mean absolute RTT variation
- **Connection info** — your IP, provider, and the edge server serving you

## How it works

No backend to run. Measurements use Cloudflare's open speed-test endpoints
(`speed.cloudflare.com/__down` and `/__up`), which allow cross-origin requests from
any site. All computation happens client-side; results are stored only in your
browser's localStorage (recent-test history).

## Stack

Plain HTML, CSS and JavaScript. Zero dependencies, zero build step.

## Run locally

Open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8000
```

## Deploy

Static site — drop the folder on any static host. On Netlify: import the repo,
no build command, publish directory `/`.
