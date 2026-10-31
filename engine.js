/*
 * SakugaEngine — turns live video frames into "sakuga" style animation.
 *
 *  - Timing:   frames are held "on 1s / 2s / 3s" (24fps base). In auto mode the
 *              hold length follows the motion, like real key animation: fast
 *              action goes on ones, acting on twos, slow moments on threes.
 *  - Shading:  cel-shading (posterized light bands, tinted shadows, highlights)
 *              plus Sobel ink lines. Styles: TV anime, 90s cel, genga, manga ink.
 *  - Smears:   moving regions (a low-res motion mask) are stretched along the
 *              estimated motion vector and onion-skinned with the previous drawing.
 *  - Impacts:  motion spikes trigger 2-tone impact frames, speed lines,
 *              camera shake and a zoom punch.
 *  - Framing:  letterbox, film grain, vignette.
 */
(function (global) {
  'use strict';

  const VS = `attribute vec2 aPos; varying vec2 v;
  void main(){ v = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

  const COMMON = `precision highp float; varying vec2 v;
  float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
  `;

  // Pass 1: build a "drawing" from the video frame.
  const DRAW_FS = COMMON + `
  uniform sampler2D uVid; uniform sampler2D uPrev; uniform sampler2D uMask;
  uniform vec2 uTexel; uniform vec2 uMotion; uniform float uSmear; uniform float uGhost;
  uniform float uBands; uniform float uLine; uniform float uSat; uniform float uStyle; uniform float uSeed;
  uniform vec3 uShadow;
  float gMask;

  vec3 smp(vec2 uv){
    vec2 d = uMotion * uSmear * gMask;
    vec3 c = vec3(0.0); float w = 0.0;
    for (int i = 0; i < 8; i++) {
      float t = float(i) / 7.0;
      float wi = 1.0 - 0.75 * t;
      c += texture2D(uVid, uv + d * t).rgb * wi; w += wi;
    }
    return c / w;
  }

  void main(){
    gMask = smoothstep(0.12, 0.5, texture2D(uMask, v).r);
    vec2 o = uTexel * 1.3;
    vec3 c00 = smp(v + vec2(-o.x, -o.y)), c10 = smp(v + vec2(0.0, -o.y)), c20 = smp(v + vec2(o.x, -o.y));
    vec3 c01 = smp(v + vec2(-o.x, 0.0)),  c11 = smp(v),                    c21 = smp(v + vec2(o.x, 0.0));
    vec3 c02 = smp(v + vec2(-o.x, o.y)),  c12 = smp(v + vec2(0.0, o.y)),  c22 = smp(v + vec2(o.x, o.y));
    vec3 col = (c00 + c20 + c02 + c22 + 2.0 * (c10 + c01 + c21 + c12) + 4.0 * c11) / 16.0;

    float l00 = luma(c00), l10 = luma(c10), l20 = luma(c20);
    float l01 = luma(c01), l21 = luma(c21);
    float l02 = luma(c02), l12 = luma(c12), l22 = luma(c22);
    float gx = (l20 + 2.0 * l21 + l22) - (l00 + 2.0 * l01 + l02);
    float gy = (l02 + 2.0 * l12 + l22) - (l00 + 2.0 * l10 + l20);
    float edge = sqrt(gx * gx + gy * gy);

    float L = luma(col);
    float bi = floor(clamp(L, 0.0, 0.999) * uBands);
    float q = (bi + 0.5) / uBands;
    vec3 hue = col / max(L, 0.03);
    vec3 cel = clamp(hue * q, 0.0, 1.0);
    cel = clamp(mix(vec3(luma(cel)), cel, uSat), 0.0, 1.0);
    float shadowAmt = 1.0 - smoothstep(0.0, 0.55, q);
    cel = mix(cel, cel * uShadow, shadowAmt * 0.75);
    float hl = smoothstep(0.80, 0.93, L);
    cel = mix(cel, vec3(1.0, 0.98, 0.95), hl * 0.65);

    float bR = floor(clamp((l21 + l20 + l22) / 3.0, 0.0, 0.999) * uBands);
    float bU = floor(clamp((l12 + l02 + l22) / 3.0, 0.0, 0.999) * uBands);
    float bEdge = (bR != bi || bU != bi) ? 1.0 : 0.0;
    float ink = smoothstep(0.42 - 0.24 * uLine, 0.6 - 0.24 * uLine, edge) * min(uLine, 1.0);

    vec3 outc;
    if (uStyle < 0.5) {               // TV anime
      outc = mix(cel, vec3(0.10, 0.07, 0.14), ink);
    } else if (uStyle < 1.5) {        // 90s cel
      outc = cel * vec3(1.07, 1.0, 0.86) + vec3(0.025, 0.012, 0.03);
      outc = mix(outc, vec3(0.14, 0.09, 0.08), ink);
    } else if (uStyle < 2.5) {        // genga (key animation drawing)
      vec2 px = gl_FragCoord.xy;
      vec3 paper = vec3(0.95, 0.93, 0.86) - hash(floor(px / 2.0)) * 0.035;
      outc = paper;
      float hb = floor(uBands * 0.5);
      float hatch = step(0.72, fract((px.x + px.y) / 6.0)) * (bi < 0.5 ? 1.0 : 0.0);
      outc = mix(outc, vec3(0.55, 0.55, 0.6), hatch * 0.5);
      outc = mix(outc, vec3(0.86, 0.22, 0.2), bEdge * (bi < hb ? 1.0 : 0.0) * 0.85);
      outc = mix(outc, vec3(0.2, 0.42, 0.88), bEdge * (bi >= hb ? 1.0 : 0.0) * 0.6);
      float graphite = smoothstep(0.3 - 0.2 * uLine, 0.5 - 0.22 * uLine, edge);
      outc = mix(outc, vec3(0.22, 0.22, 0.26), graphite * (0.75 + 0.25 * hash(px + uSeed)));
    } else {                          // manga ink / screentone
      vec2 g = fract(gl_FragCoord.xy / 5.0) - 0.5;
      float dark = step(length(g), (1.0 - q) * 0.68);
      outc = vec3(1.0 - dark);
      if (bi < 0.5) outc = vec3(0.0);
      if (L > 0.78) outc = vec3(1.0);
      outc = mix(outc, vec3(0.0), max(ink, smoothstep(0.25, 0.45, edge)));
    }

    vec3 prev = texture2D(uPrev, v + uMotion * 0.6).rgb;
    outc = mix(outc, prev, uGhost * gMask * 0.55);
    gl_FragColor = vec4(outc, 1.0);
  }`;

  // Pass 2: framing / impact frames / speed lines / letterbox / grain.
  const SHOW_FS = COMMON + `
  uniform sampler2D uDraw; uniform vec2 uShake; uniform float uZoom;
  uniform float uImpact; uniform float uImpactMode; uniform float uSpeed; uniform vec2 uFocus;
  uniform float uAspect; uniform float uBars; uniform float uGrain; uniform float uVig; uniform float uSeed;
  void main(){
    vec2 uv = (v - 0.5) / uZoom + 0.5 + uShake;
    uv = clamp(uv, vec2(0.001), vec2(0.999));
    vec3 c = texture2D(uDraw, uv).rgb;
    vec3 lineCol = vec3(1.0);
    if (uImpact > 0.5) {
      float t = smoothstep(0.38, 0.47, luma(c));
      if (uImpactMode < 0.5) { c = mix(vec3(0.03, 0.0, 0.03), vec3(1.0, 0.96, 0.88), t); lineCol = vec3(1.0, 0.96, 0.88); }
      else { c = mix(vec3(0.98, 0.97, 0.95), vec3(0.78, 0.03, 0.08), t); lineCol = vec3(0.04); }
    }
    if (uSpeed > 0.01) {
      vec2 p = v - uFocus; p.x *= uAspect;
      float r = length(p);
      float a = (atan(p.y, p.x) + 3.14159265) / 6.2831853;
      float k = 180.0;
      float id = floor(a * k);
      float f = fract(a * k);
      float on = step(1.0 - 0.3 * uSpeed, hash(vec2(id, uSeed)));
      float inner = 0.2 + 0.32 * hash(vec2(id + 7.0, uSeed));
      float w = 0.45 * smoothstep(inner, inner + 0.6, r);
      float m = on * step(abs(f - 0.5), w) * smoothstep(inner, inner + 0.06, r);
      c = mix(c, lineCol, m * 0.92);
    }
    vec2 q = v - 0.5;
    c *= 1.0 - dot(q, q) * uVig;
    float bar = step(0.5 - uBars, abs(v.y - 0.5));
    c += (hash(v * vec2(1931.0, 1171.0) + uSeed) - 0.5) * uGrain;
    c = mix(c, vec3(0.0), bar);
    gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
  }`;

  const STYLES = {
    tv:    { id: 0, shadow: [0.62, 0.58, 0.95], vig: 0.15 },
    cel90: { id: 1, shadow: [0.78, 0.55, 0.72], vig: 0.6 },
    genga: { id: 2, shadow: [1, 1, 1], vig: 0.0 },
    ink:   { id: 3, shadow: [1, 1, 1], vig: 0.0 },
  };

  const DEFAULTS = {
    style: 'tv', timing: 'auto', bands: 4, line: 0.8, sat: 1.3, smear: 0.8,
    impact: 0.55, grain: 0.04, speedLines: true, shake: true, letterbox: 'none', maxDim: 1280,
  };

  class SakugaEngine {
    constructor(canvas) {
      this.canvas = canvas;
      const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, antialias: false, premultipliedAlpha: false });
      if (!gl) throw new Error('WebGL is not available in this browser.');
      this.gl = gl;
      this.fps = 24;
      this.params = Object.assign({}, DEFAULTS);
      this.pDraw = this._program(DRAW_FS);
      this.pShow = this._program(SHOW_FS);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      this.vidTex = this._texture();
      this.maskTex = this._texture();
      this.fbos = [];
      this.W = 0; this.H = 0;
      this.an = document.createElement('canvas');
      this.actx = this.an.getContext('2d', { willReadFrequently: true });
      this.onPeak = null;
      this.reset();
    }

    _program(fs) {
      const gl = this.gl;
      const mk = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      const p = gl.createProgram();
      gl.attachShader(p, mk(gl.VERTEX_SHADER, VS));
      gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
      gl.bindAttribLocation(p, 0, 'aPos');
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      p.loc = {};
      return p;
    }

    _u(p, name) {
      if (!(name in p.loc)) p.loc[name] = this.gl.getUniformLocation(p, name);
      return p.loc[name];
    }

    _texture() {
      const gl = this.gl, t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      return t;
    }

    setSource(video) {
      const gl = this.gl;
      const vw = video.videoWidth || 640, vh = video.videoHeight || 360;
      const s = Math.min(1, this.params.maxDim / Math.max(vw, vh));
      this.W = Math.max(2, Math.round(vw * s / 2) * 2);
      this.H = Math.max(2, Math.round(vh * s / 2) * 2);
      this.canvas.width = this.W; this.canvas.height = this.H;
      this.fbos.forEach(f => { gl.deleteFramebuffer(f.fb); gl.deleteTexture(f.tex); });
      this.fbos = [0, 1].map(() => {
        const tex = this._texture();
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.W, this.H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
        return { fb, tex };
      });
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.AW = 64; this.AH = Math.max(16, Math.round(64 * this.H / this.W));
      this.an.width = this.AW; this.an.height = this.AH;
      this.reset();
    }

    reset() {
      this.prevG = null;
      this.lastDrawVf = null;
      this.ema = 0;
      this.impactLeft = 0; this.impactMode = 0; this.lastImpactT = -10;
      this.shake = 0; this.punch = 0; this.speedLeft = 0;
      this.cur = 0;
      this.peak = 0;
      this.last = null;
      this.info = { hold: 2, motion: 0, impact: false, smear: 0 };
      this.stats = { drawings: 0, ones: 0, twos: 0, threes: 0, impacts: 0, smears: 0, pans: 0, motionSum: 0, cuts: 0 };
    }

    // Low-res motion analysis: mean frame difference, a motion mask, and motion
    // vectors from block matching (global pan + masked "moving object").
    _analyze(video, elapsed) {
      const AW = this.AW, AH = this.AH, N = AW * AH;
      this.actx.drawImage(video, 0, 0, AW, AH);
      const d = this.actx.getImageData(0, 0, AW, AH).data;
      const g = new Float32Array(N);
      for (let i = 0; i < N; i++) g[i] = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) / 255;
      const prev = this.prevG;
      this.prevG = g;
      const out = { m: 0, top: 0, mv: [0, 0], cx: 0.5, cy: 0.5, pan: false, mask: new Uint8Array(N) };
      if (!prev) return out;

      const diff = new Float32Array(N);
      let sum = 0, wx = 0, wy = 0;
      for (let y = 0; y < AH; y++) for (let x = 0; x < AW; x++) {
        const i = y * AW + x, dd = Math.abs(g[i] - prev[i]);
        diff[i] = dd; sum += dd; wx += dd * x; wy += dd * y;
      }
      out.m = sum / N / Math.sqrt(elapsed);
      // energy of the most active 12% of the frame: catches small fast objects
      const sorted = Float32Array.from(diff).sort();
      let top = 0; const k = Math.max(1, Math.floor(N * 0.12));
      for (let i = N - k; i < N; i++) top += sorted[i];
      out.top = top / k / Math.sqrt(elapsed);
      if (sum > 0) { out.cx = wx / sum / AW; out.cy = wy / sum / AH; }

      // blurred mask
      for (let y = 0; y < AH; y++) for (let x = 0; x < AW; x++) {
        let s = 0, c = 0;
        for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
          const yy = y + j, xx = x + k;
          if (yy >= 0 && yy < AH && xx >= 0 && xx < AW) { s += diff[yy * AW + xx]; c++; }
        }
        out.mask[y * AW + x] = Math.min(255, (s / c) * 5 * 255);
      }

      // block matching: find s so that cur(x) ≈ prev(x - s)
      const R = 6;
      const match = (masked) => {
        let best = Infinity, bx = 0, by = 0, zero = 0;
        for (let sy = -R; sy <= R; sy++) for (let sx = -R; sx <= R; sx++) {
          let sad = 0, cnt = 0;
          for (let y = R; y < AH - R; y++) for (let x = R; x < AW - R; x++) {
            const i = y * AW + x;
            if (masked && diff[i] < 0.05) continue;
            sad += Math.abs(g[i] - prev[(y - sy) * AW + (x - sx)]); cnt++;
          }
          if (cnt < 12) return null;
          sad /= cnt;
          if (sx === 0 && sy === 0) zero = sad;
          if (sad < best) { best = sad; bx = sx; by = sy; }
        }
        return { bx, by, best, zero };
      };
      const gm = match(false);
      if (gm && gm.best < gm.zero * 0.8 && (gm.bx || gm.by)) {
        out.pan = true;
        out.mv = [gm.bx / AW / elapsed, -gm.by / AH / elapsed];
      } else {
        const om = match(true);
        if (om && om.best < om.zero * 0.9) out.mv = [om.bx / AW / elapsed, -om.by / AH / elapsed];
      }
      return out;
    }

    // Call once per decoded video frame. Returns true if a new drawing was made.
    frame(video, t) {
      if (!this.W) return false;
      const vf = Math.floor(t * this.fps + 1e-4);
      if (this.lastDrawVf !== null && vf < this.lastDrawVf) this.reset();
      if (this.lastDrawVf !== null && vf - this.lastDrawVf < this.info.hold) return false;
      const elapsed = this.lastDrawVf === null ? 1 : Math.max(1, vf - this.lastDrawVf);
      this.lastDrawVf = vf;

      const P = this.params, S = this.stats;
      const a = this._analyze(video, elapsed);
      const m = a.m, top = a.top;
      const cut = m > 0.16;
      const emaPrev = this.ema || top;
      this.ema = cut ? top * 0.3 : emaPrev * 0.85 + top * 0.15;

      // impact detection
      const thr = 0.10 - 0.08 * P.impact, ratio = 2.8 - 1.2 * P.impact;
      let impactNow = false;
      if (this.impactLeft > 0) { impactNow = true; this.impactLeft--; this.impactMode ^= 1; }
      else if (P.impact > 0 && !cut && S.drawings > 2 && top > thr && top > emaPrev * ratio && t - this.lastImpactT > 0.7) {
        impactNow = true; this.impactLeft = 1; this.impactMode = 0; this.lastImpactT = t;
        S.impacts++;
        if (P.shake) { this.shake = 1; this.punch = 1; }
        this.speedLeft = 4;
      }

      // timing
      let hold;
      if (impactNow) hold = 1;
      else if (P.timing === 'auto') hold = (top > 0.09 || m > 0.035) ? 1 : (top > 0.03 || m > 0.01) ? 2 : 3;
      else hold = +P.timing;
      this.info.hold = hold;
      if (hold === 1) S.ones++; else if (hold === 2) S.twos++; else S.threes++;

      // smear
      const speed = Math.hypot(a.mv[0], a.mv[1]);
      let smear = cut ? 0 : Math.min(1, Math.max(0, (speed - 0.008) / 0.025)) * P.smear;
      if (!cut && (m > 0.06 || top > 0.12)) smear = Math.max(smear, 0.4 * P.smear);
      let mvx = a.mv[0] * hold * 1.8, mvy = a.mv[1] * hold * 1.8;
      const len = Math.hypot(mvx, mvy);
      if (len > 0.15) { mvx *= 0.15 / len; mvy *= 0.15 / len; }
      if (smear > 0.4) S.smears++;
      if (a.pan) S.pans++;
      if (cut) S.cuts++;

      // camera
      const shakeAmt = this.shake * 0.022;
      const shakeV = [(Math.random() - 0.5) * 2 * shakeAmt, (Math.random() - 0.5) * 2 * shakeAmt];
      const zoom = 1 + 0.08 * this.punch + (this.shake > 0.02 ? 0.03 : 0);
      this.shake *= 0.55; this.punch *= 0.6;
      let speedAmt = 0;
      if (P.speedLines) {
        if (impactNow) speedAmt = 1;
        else if (this.speedLeft > 0) { speedAmt = 0.5; this.speedLeft--; }
        else if (m > 0.07 || top > 0.2) speedAmt = 0.35;
      }

      this.last = {
        mv: [mvx, mvy], smear, ghost: smear * 0.7, mask: a.mask, impact: impactNow, impactMode: this.impactMode,
        shake: shakeV, zoom, speed: speedAmt, focus: [a.cx, 1 - a.cy], seed: Math.random() * 100,
      };
      this._render(video, this.last, true);

      S.drawings++; S.motionSum += m;
      this.info.motion = m; this.info.impact = impactNow; this.info.smear = smear;
      const score = cut || impactNow ? 0 : top + smear * 0.05;
      if (t > 0.25 && score > this.peak) { this.peak = score; if (this.onPeak) this.onPeak(); }
      return true;
    }

    // Re-render the current frame with new parameters (e.g. while paused).
    rerender(video) {
      if (!this.W || !this.last) return;
      this._render(video, this.last, false);
    }

    _render(video, st, advance) {
      const gl = this.gl, P = this.params, sty = STYLES[P.style] || STYLES.tv;
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.vidTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, this.AW, this.AH, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, st.mask);

      if (advance) this.cur ^= 1;
      const dst = this.fbos[this.cur], prev = this.fbos[this.cur ^ 1];
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, prev.tex);

      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      gl.enableVertexAttribArray(0);

      // pass 1
      let p = this.pDraw;
      gl.useProgram(p);
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
      gl.viewport(0, 0, this.W, this.H);
      gl.uniform1i(this._u(p, 'uVid'), 0);
      gl.uniform1i(this._u(p, 'uPrev'), 1);
      gl.uniform1i(this._u(p, 'uMask'), 2);
      gl.uniform2f(this._u(p, 'uTexel'), 1 / this.W, 1 / this.H);
      gl.uniform2f(this._u(p, 'uMotion'), st.mv[0], st.mv[1]);
      gl.uniform1f(this._u(p, 'uSmear'), st.smear);
      gl.uniform1f(this._u(p, 'uGhost'), st.ghost);
      gl.uniform1f(this._u(p, 'uBands'), P.bands);
      gl.uniform1f(this._u(p, 'uLine'), P.line);
      gl.uniform1f(this._u(p, 'uSat'), P.sat);
      gl.uniform1f(this._u(p, 'uStyle'), sty.id);
      gl.uniform1f(this._u(p, 'uSeed'), st.seed);
      gl.uniform3fv(this._u(p, 'uShadow'), sty.shadow);
      this._quad();

      // pass 2
      p = this.pShow;
      gl.useProgram(p);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.W, this.H);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, dst.tex);
      gl.uniform1i(this._u(p, 'uDraw'), 0);
      gl.uniform2f(this._u(p, 'uShake'), st.shake[0], st.shake[1]);
      gl.uniform1f(this._u(p, 'uZoom'), st.zoom);
      gl.uniform1f(this._u(p, 'uImpact'), st.impact ? 1 : 0);
      gl.uniform1f(this._u(p, 'uImpactMode'), st.impactMode);
      gl.uniform1f(this._u(p, 'uSpeed'), st.speed);
      gl.uniform2f(this._u(p, 'uFocus'), st.focus[0], st.focus[1]);
      gl.uniform1f(this._u(p, 'uAspect'), this.W / this.H);
      gl.uniform1f(this._u(p, 'uBars'), this._bars());
      gl.uniform1f(this._u(p, 'uGrain'), P.grain);
      gl.uniform1f(this._u(p, 'uVig'), sty.vig);
      gl.uniform1f(this._u(p, 'uSeed'), st.seed);
      this._quad();
    }

    _quad() {
      const gl = this.gl;
      const b = this._qb || (this._qb = (() => {
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        return buf;
      })());
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    _bars() {
      const ar = { none: 0, '1.85': 1.85, '2.39': 2.39 }[this.params.letterbox] || 0;
      if (!ar) return 0;
      const visible = (this.W / ar) / this.H;
      return visible >= 1 ? 0 : (1 - visible) / 2;
    }
  }

  SakugaEngine.DEFAULTS = DEFAULTS;
  global.SakugaEngine = SakugaEngine;
})(window);
