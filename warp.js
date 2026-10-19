/* Velocity — WebGL2 warp field. Real GPU 3D: a particle tunnel that reacts to
   measured throughput. Zero dependencies; falls back silently without WebGL2. */
(function () {
  "use strict";

  var canvas = document.getElementById("warp");
  if (!canvas) return;
  var gl = canvas.getContext("webgl2", { alpha: true, antialias: true });
  if (!gl) { canvas.remove(); return; } // CSS aurora remains as fallback

  var VERT = `#version 300 es
  precision highp float;
  uniform float u_time;
  uniform float u_speed;    // 0..1 normalized measured speed
  uniform vec2  u_res;
  out float v_depth;
  out float v_twinkle;

  float hash(int n) {
    int x = n * 747796405 + 2891336453;
    x = ((x >> ((x >> 28) + 4)) ^ x) * 277803737;
    return float(((x >> 22) ^ x) & 0xFFFFFF) / float(0xFFFFFF);
  }

  void main() {
    int id = gl_VertexID;
    float h1 = hash(id);
    float h2 = hash(id + 1013904223);
    float h3 = hash(id + 1664525);

    // particle home position in a wide disc around the tunnel axis
    float ang = h1 * 6.2831853;
    float rad = 0.25 + 0.75 * pow(h2, 0.6);
    float x = cos(ang) * rad;
    float y = sin(ang) * rad;

    // depth cycles toward the camera; speed drives travel rate
    float travel = u_time * (0.02 + u_speed * 0.55) * (0.6 + 0.4 * h3);
    float z = fract(h3 + travel);          // 0 = far, 1 = at the camera
    float depth = 1.0 - z;                  // perspective divisor
    float persp = 1.0 / (0.12 + depth * 1.6);

    vec2 pos = vec2(x, y) * persp;
    pos.x *= u_res.y / u_res.x;             // aspect-correct

    // slight spiral swirl that tightens with speed
    float sw = u_time * 0.05 * (0.5 + u_speed);
    float ca = cos(sw * (1.0 - depth)), sa = sin(sw * (1.0 - depth));
    pos = mat2(ca, -sa, sa, ca) * pos;

    gl_Position = vec4(pos, 0.0, 1.0);
    float size = (1.0 + 26.0 * z * z * (0.4 + u_speed));
    gl_PointSize = size * (u_res.y / 900.0);
    v_depth = z;
    v_twinkle = 0.75 + 0.25 * sin(u_time * (1.0 + h1 * 3.0) + h2 * 40.0);
  }`;

  var FRAG = `#version 300 es
  precision highp float;
  in float v_depth;
  in float v_twinkle;
  uniform float u_speed;
  out vec4 outColor;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    float a = smoothstep(0.5, 0.05, d);

    // speed palette: slow = dim slate blue, mid = cyan, fast = electric blue-green
    vec3 slow = vec3(0.22, 0.32, 0.55);
    vec3 mid  = vec3(0.39, 0.82, 1.00);
    vec3 fast = vec3(0.19, 0.90, 0.62);
    vec3 col = mix(slow, mid, clamp(u_speed * 1.6, 0.0, 1.0));
    col = mix(col, fast, smoothstep(0.55, 1.0, u_speed));

    // near particles streak brighter
    float glow = pow(v_depth, 2.2);
    float alpha = a * (0.10 + glow * 0.85) * v_twinkle;
    outColor = vec4(col * (0.6 + glow * 1.4), alpha);
  }`;

  function compile(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      return null;
    }
    return s;
  }
  var vs = compile(gl.VERTEX_SHADER, VERT);
  var fs = compile(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) { canvas.remove(); return; }
  var prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { canvas.remove(); return; }
  gl.useProgram(prog);
  gl.bindVertexArray(gl.createVertexArray());
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // additive glow

  var uTime = gl.getUniformLocation(prog, "u_time");
  var uSpeed = gl.getUniformLocation(prog, "u_speed");
  var uRes = gl.getUniformLocation(prog, "u_res");

  var COUNT = 2600;
  var speedTarget = 0.06, speedShown = 0.06;
  var running = true;

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.floor(canvas.clientWidth * dpr);
    var h = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }
  window.addEventListener("resize", resize);

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  var start = performance.now();
  function frame() {
    if (!running) return;
    if (reduceMotion.matches) { gl.clear(gl.COLOR_BUFFER_BIT); return; }
    resize();
    speedShown += (speedTarget - speedShown) * 0.045;
    gl.uniform1f(uTime, (performance.now() - start) / 1000);
    gl.uniform1f(uSpeed, speedShown);
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.POINTS, 0, COUNT);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) { running = false; }
    else if (!running) { running = true; start = performance.now() - ((performance.now() - start)); requestAnimationFrame(frame); }
  });

  // Public controller used by the test engine.
  window.VelocityWarp = {
    // mbps: live measured throughput; idle when null
    setSpeed: function (mbps) {
      if (mbps == null || !(mbps > 0)) { speedTarget = 0.06; return; }
      var n = Math.log10(1 + mbps) / Math.log10(1001); // same log scale as the gauge
      speedTarget = 0.12 + Math.min(1, n) * 0.88;
    },
    setBoost: function (on) { speedTarget = on ? Math.max(speedTarget, 0.35) : speedTarget; }
  };
})();
