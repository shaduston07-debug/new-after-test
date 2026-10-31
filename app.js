/* Sakugify — a local, Sakugabooru-style animation gallery.
 * Every post gets a frame-accurate player: step frame by frame or drawing by drawing,
 * slow playback, and a timing sheet showing which drawings are held on 1s, 2s or 3s. */
(function () {
  'use strict';

  const SEED_URL = 'clips/seed.json';
  const FPS_CHOICES = [8, 12, 15, 23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];

  // ---------------- storage (IndexedDB, with in-memory fallback) ----------------
  const Store = {
    db: null, mem: null,
    async init() {
      if (this.db || this.mem) return;
      try {
        this.db = await new Promise((res, rej) => {
          const r = indexedDB.open('sakugify-booru', 1);
          r.onupgradeneeded = () => {
            r.result.createObjectStore('posts', { keyPath: 'id', autoIncrement: true });
            r.result.createObjectStore('cache', { keyPath: 'key' });
          };
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
          r.onblocked = () => rej(new Error('blocked'));
        });
      } catch (e) {
        this.mem = { posts: new Map(), cache: new Map(), next: 1 };
      }
    },
    async op(name, mode, fn) {
      await this.init();
      if (this.mem) {
        const m = this.mem[name], mem = this.mem;
        return fn({
          getAll: () => [...m.values()],
          get: k => m.get(k),
          put: v => { if (name === 'posts' && v.id == null) v.id = mem.next++; const k = name === 'posts' ? v.id : v.key; m.set(k, v); return k; },
          delete: k => m.delete(k),
        });
      }
      return new Promise((res, rej) => {
        const tx = this.db.transaction(name, mode), s = tx.objectStore(name);
        const req = fn({ getAll: () => s.getAll(), get: k => s.get(k), put: v => s.put(v), delete: k => s.delete(k) });
        tx.oncomplete = () => res(req && req.result);
        tx.onerror = () => rej(tx.error);
      });
    },
    all(n) { return this.op(n, 'readonly', s => s.getAll()); },
    get(n, k) { return this.op(n, 'readonly', s => s.get(k)); },
    put(n, v) { return this.op(n, 'readwrite', s => s.put(v)); },
    del(n, k) { return this.op(n, 'readwrite', s => s.delete(k)); },
  };

  const Votes = {
    get(id) { try { return +(localStorage.getItem('vote:' + id) || 0); } catch (e) { return 0; } },
    set(id, n) { try { localStorage.setItem('vote:' + id, n); } catch (e) { /* ignore */ } },
  };

  // ---------------- helpers ----------------
  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const normTag = s => String(s || '').trim().toLowerCase().replace(/\s+/g, '_').replace(/[^\p{L}\p{N}_\-:().!?']/gu, '');
  const fmtTime = s => { s = Math.max(0, s || 0); return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'); };
  const fmtPrecise = s => { s = Math.max(0, s || 0); return Math.floor(s / 60) + ':' + (s % 60).toFixed(2).padStart(5, '0'); };
  const fmtSize = b => b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB';
  const fmtFps = f => (Math.round(f * 1000) / 1000).toString();
  const snapFps = f => FPS_CHOICES.reduce((a, b) => Math.abs(b - f) < Math.abs(a - f) ? b : a, 24);
  const view = $('#view');
  let cleanup = [];
  const onLeave = fn => cleanup.push(fn);
  const once = (el, ev) => new Promise((res, rej) => {
    const ok = () => { off(); res(); }, bad = () => { off(); rej(new Error('This video could not be decoded.')); };
    const off = () => { el.removeEventListener(ev, ok); el.removeEventListener('error', bad); };
    el.addEventListener(ev, ok); el.addEventListener('error', bad);
  });

  // ---------------- tags ----------------
  const TYPE_ORDER = ['artist', 'copyright', 'meta', 'general'];
  const tagType = (post, t) => (post.tagTypes && post.tagTypes[t]) || 'general';
  const tagLink = (t, type, count) =>
    `<li><a class="q" href="#posts" data-tag="${esc(t)}" title="Search only this tag">?</a>
      <a class="tag-${type}" href="#posts" data-tag="${esc(t)}">${esc(t.replace(/_/g, ' '))}</a>
      ${count != null ? `<span class="count">${count}</span>` : ''}</li>`;
  function matches(post, query) {
    const terms = query.split(/\s+/).map(normTag).filter(Boolean);
    return terms.every(t => t.startsWith('-') ? !post.tags.includes(t.slice(1)) : post.tags.includes(t));
  }
  function tagCounts(posts) {
    const counts = new Map();
    posts.forEach(p => p.tags.forEach(t => {
      const c = counts.get(t) || { n: 0, type: tagType(p, t) };
      c.n++; counts.set(t, c);
    }));
    return [...counts.entries()].sort((a, b) =>
      TYPE_ORDER.indexOf(a[1].type) - TYPE_ORDER.indexOf(b[1].type) || b[1].n - a[1].n || a[0].localeCompare(b[0]));
  }

  // ---------------- timing analysis ----------------
  // A "drawing" starts on every frame that differs from the previous one by more than
  // the noise floor. Frames are compared after cancelling flicker and small pans, and the
  // threshold adapts per clip (Otsu split on log differences) when there is a clear split.
  function drawingThreshold(d) {
    if (d.length < 4) return 0.012;
    const v = d.map(x => Math.log10(x + 1e-4));
    const lo = Math.min(...v), hi = Math.max(...v);
    if (hi - lo < 0.3) return 0.012;
    const B = 64, hist = new Array(B).fill(0);
    v.forEach(x => hist[Math.min(B - 1, Math.floor((x - lo) / (hi - lo) * B))]++);
    let sum = 0; hist.forEach((h, i) => { sum += i * h; });
    let wB = 0, sB = 0, best = -1, bi = 0, mL = 0, mU = 0;
    for (let i = 0; i < B; i++) {
      wB += hist[i]; if (!wB) continue;
      const wF = v.length - wB; if (!wF) break;
      sB += i * hist[i];
      const mB = sB / wB, mF = (sum - sB) / wF, between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; bi = i; mL = mB; mU = mF; }
    }
    if ((mU - mL) / B * (hi - lo) < 0.5) return 0.012;   // one cluster: no clear held/new split
    return Math.min(0.02, Math.max(0.008, Math.pow(10, lo + (bi + 1) / B * (hi - lo)) - 1e-4));
  }
  // Difference between two frames after cancelling brightness flicker and small camera pans.
  const AW = 96, AH = 72, R = 3;
  function frameDiff(a, b) {
    let best = Infinity;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      let s = 0;
      for (let y = R; y < AH - R; y++) {
        const ra = y * AW, rb = (y + dy) * AW + dx;
        for (let x = R; x < AW - R; x++) s += Math.abs(a[ra + x] - b[rb + x]);
      }
      if (s < best) best = s;
    }
    return best / ((AW - 2 * R) * (AH - 2 * R));
  }
  function toGray(px) {
    const g = new Float32Array(AW * AH); let m = 0;
    for (let i = 0; i < g.length; i++) { g[i] = (px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114) / 255; m += g[i]; }
    m /= g.length;
    for (let i = 0; i < g.length; i++) g[i] -= m;
    return g;
  }
  function drawingsFromDiffs(d) {
    const thr = drawingThreshold(d.slice(1));
    const starts = [0];
    for (let i = 1; i < d.length; i++) if (d[i] > thr) starts.push(i);
    return starts;
  }
  function timingSummary(starts, N) {
    const s = { ones: 0, twos: 0, threes: 0, holds: 0, drawings: starts.length };
    starts.forEach((st, i) => {
      const len = (i + 1 < starts.length ? starts[i + 1] : N) - st;
      if (len <= 1) s.ones += len; else if (len === 2) s.twos += len; else if (len === 3) s.threes += len; else s.holds += len;
    });
    return s;
  }
  function timingTags(s, N) {
    const t = [];
    const f = k => s[k] / (N || 1);
    if (f('ones') >= 0.5) t.push('on_ones');
    else if (f('twos') >= 0.5) t.push('on_twos');
    else if (f('threes') >= 0.5) t.push('on_threes');
    else t.push('mixed_timing');
    if (f('ones') >= 0.6) t.push('full_animation');
    if (f('holds') >= 0.35) t.push('limited_animation');
    return t;
  }

  async function openScanner(src) {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = src;
    await once(v, 'loadeddata');
    return v;
  }
  const seekTo = (v, t) => new Promise(res => {
    const done = () => { v.removeEventListener('seeked', done); res(); };
    v.addEventListener('seeked', done);
    v.currentTime = t;
  });

  // Full pass over every frame: returns drawing start frames plus a poster thumbnail.
  async function analyzeClip(src, fps, onProgress, isAlive) {
    const v = await openScanner(src);
    const N = Math.max(1, Math.round(v.duration * fps));
    const c = Object.assign(document.createElement('canvas'), { width: AW, height: AH });
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const d = new Array(N).fill(0);
    let prev = null, poster = null;
    for (let f = 0; f < N; f++) {
      if (!isAlive()) throw new Error('cancelled');
      await seekTo(v, (f + 0.5) / fps);
      ctx.drawImage(v, 0, 0, AW, AH);
      const g = toGray(ctx.getImageData(0, 0, AW, AH).data);
      if (prev) d[f] = frameDiff(g, prev);
      prev = g;
      if (f === Math.floor(N / 3)) {
        const pc = Object.assign(document.createElement('canvas'), { width: 360, height: Math.round(360 * v.videoHeight / v.videoWidth) });
        pc.getContext('2d').drawImage(v, 0, 0, pc.width, pc.height);
        poster = pc.toDataURL('image/jpeg', 0.82);
      }
      if (onProgress && f % 4 === 0) onProgress(f / N);
    }
    v.removeAttribute('src'); v.load();
    return { N, starts: drawingsFromDiffs(d), poster };
  }

  // Thumbnail for each drawing, filled in progressively.
  async function drawingThumbs(src, fps, starts, onThumb, isAlive) {
    const v = await openScanner(src);
    const tw = 128, th = Math.round(tw * v.videoHeight / v.videoWidth);
    const c = Object.assign(document.createElement('canvas'), { width: tw, height: th });
    const ctx = c.getContext('2d');
    const out = [];
    for (let i = 0; i < starts.length; i++) {
      if (!isAlive()) return null;
      await seekTo(v, (starts[i] + 0.5) / fps);
      ctx.drawImage(v, 0, 0, tw, th);
      out[i] = c.toDataURL('image/jpeg', 0.7);
      onThumb(i, out[i]);
    }
    v.removeAttribute('src'); v.load();
    return out;
  }

  async function detectFps(video) {
    if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return null;
    return new Promise(res => {
      const times = [];
      let finished = false;
      const finish = () => {
        if (finished) return; finished = true;
        const deltas = [];
        for (let i = 1; i < times.length; i++) { const dt = times[i] - times[i - 1]; if (dt > 0.004) deltas.push(dt); }
        if (!deltas.length) return res(null);
        res(snapFps(1 / Math.min(...deltas)));
      };
      const cb = (now, meta) => { times.push(meta.mediaTime); if (times.length < 16) video.requestVideoFrameCallback(cb); else finish(); };
      video.requestVideoFrameCallback(cb);
      setTimeout(finish, 3000);
    });
  }

  // ---------------- data ----------------
  let seedCache = null;
  async function seeds() {
    if (seedCache) return seedCache;
    try {
      const list = await (await fetch(SEED_URL)).json();
      seedCache = list.map((s, i) => {
        const tagTypes = {}, tags = [];
        const add = (t, type) => { t = normTag(t); if (t && !tags.includes(t)) { tags.push(t); tagTypes[t] = type; } };
        add(s.artist || 'artist_unknown', 'artist');
        add(s.copyright, 'copyright');
        add(s.studio, 'copyright');
        timingTags(timingSummary(s.drawings, s.frames), s.frames).forEach(t => add(t, 'meta'));
        add('public_domain', 'meta');
        ['western', 'animated'].concat(String(s.tags || '').split(/\s+/)).forEach(t => add(t, 'general'));
        return {
          id: 's' + (i + 1), seed: true, title: s.title, year: s.year, artist: s.artist, src: 'clips/' + s.key + '.webm',
          thumb: 'clips/' + s.key + '.jpg', fps: s.fps, frames: s.frames, starts: s.drawings, duration: s.duration,
          width: s.w, height: s.h, bytes: s.bytes, source: 'https://archive.org/details/' + s.ia, sourceLabel: 'archive.org/details/' + s.ia,
          start: s.start, tags, tagTypes, created: Date.parse(s.year + '-01-01'),
        };
      });
    } catch (e) { seedCache = []; }
    return seedCache;
  }
  async function allPosts() {
    const user = (await Store.all('posts')).sort((a, b) => b.id - a.id);
    return user.concat(await seeds());
  }
  async function findPost(id) {
    if (String(id).startsWith('s')) return (await seeds()).find(p => p.id === id);
    return Store.get('posts', +id);
  }
  // A playable URL for a post. Seed clips are fetched once and kept as blob URLs
  // (works on any host); user posts get a temporary URL for their stored blob.
  const seedBlobs = new Map();
  async function postUrl(p) {
    if (!p.seed) return { url: URL.createObjectURL(p.blob), temp: true };
    if (!seedBlobs.has(p.src)) {
      seedBlobs.set(p.src, fetch(p.src).then(r => { if (!r.ok) throw new Error(r.status); return r.blob(); })
        .then(b => URL.createObjectURL(b)).catch(() => p.src));
    }
    return { url: await seedBlobs.get(p.src), temp: false };
  }

  // ---------------- router ----------------
  let currentQuery = '';
  function search(q) {
    currentQuery = (q || '').trim();
    if (location.hash === '#posts') route(); else location.hash = '#posts';
  }
  async function route() {
    cleanup.forEach(fn => { try { fn(); } catch (e) { /* ignore */ } });
    cleanup = [];
    const h = location.hash.slice(1) || 'posts';
    const post = /^post-(s?\d+)$/.exec(h);
    const section = post ? 'post' : h;
    document.querySelectorAll('[data-nav]').forEach(a =>
      a.classList.toggle('active', a.dataset.nav === (section === 'post' ? 'posts' : section)));
    $('#topQ').value = section === 'posts' ? currentQuery : '';
    window.scrollTo(0, 0);
    if (post) return renderPost(post[1]);
    if (section === 'upload') return renderUpload();
    if (section === 'tags') return renderTags();
    if (section === 'about') return renderAbout();
    return renderPosts(currentQuery);
  }
  window.addEventListener('hashchange', route);
  $('#topSearch').addEventListener('submit', e => { e.preventDefault(); search($('#topQ').value); });
  document.addEventListener('click', e => {
    const a = e.target.closest('a[data-tag]');
    if (a) { e.preventDefault(); search(a.dataset.tag); }
  });

  // ---------------- posts list ----------------
  async function renderPosts(query) {
    const all = await allPosts();
    const posts = query ? all.filter(p => matches(p, query)) : all;
    const tags = tagCounts(posts).slice(0, 40);
    view.innerHTML = `
      <div class="layout">
        <aside class="side">
          <section><h4>Search</h4>
            <form id="sideSearch"><input name="q" id="sideQ" value="${esc(query)}" placeholder="tags" aria-label="Search tags"></form>
            ${query ? `<p class="hint">${posts.length} post${posts.length === 1 ? '' : 's'} · <a href="#posts" data-tag="">clear</a></p>` : ''}</section>
          <section><h4>Tags</h4><ul class="taglist">${tags.map(([t, c]) => tagLink(t, c.type, c.n)).join('') || '<li class="count">No tags</li>'}</ul></section>
        </aside>
        <section>
          ${posts.length ? `<div class="grid">${posts.map(p => `
            <a class="thumb" href="#post-${p.id}" data-id="${p.id}" title="${esc(p.title)} — ${esc(p.tags.join(' '))}">
              <img src="${esc(p.thumb)}" alt="${esc(p.title)}" loading="lazy">
              <span class="badge">${fmtTime(p.duration)}</span>
              ${p.seed ? '' : '<span class="badge mine">yours</span>'}
            </a>`).join('')}</div>`
          : `<div class="empty">${all.length ? 'No posts match <b>' + esc(query) + '</b>.' : 'No posts yet.'}
              <br><a class="btn primary" href="#upload">Upload a clip</a></div>`}
        </section>
      </div>`;
    $('#sideSearch').addEventListener('submit', e => { e.preventDefault(); search(e.target.q.value); });
    const byId = new Map(posts.map(p => [String(p.id), p]));
    view.querySelectorAll('.thumb').forEach(a => {
      let vid, url;
      a.addEventListener('mouseenter', async () => {
        const p = byId.get(a.dataset.id);
        const u = await postUrl(p);
        url = u.temp ? u.url : null;
        if (vid) return;
        if (!a.matches(':hover')) return;
        vid = Object.assign(document.createElement('video'), { src: u.url, muted: true, loop: true, autoplay: true, playsInline: true });
        a.appendChild(vid);
      });
      a.addEventListener('mouseleave', () => {
        if (vid) { vid.remove(); vid = null; }
        if (url) URL.revokeObjectURL(url);
        url = null;
      });
    });
  }

  // ---------------- the player ----------------
  function mountPlayer(root, post, url) {
    const fps = post.fps;
    root.innerHTML = `
      <div class="player">
        <div class="screen"><video id="pv" playsinline muted loop autoplay preload="auto" src="${esc(url)}"></video>
          <div class="osd"><span id="osdF">F 0</span><span id="osdH" class="h2" hidden>ON 2s</span></div></div>
        <div class="sheet" id="sheet" role="slider" aria-label="Timing sheet: each block is one drawing" tabindex="0">
          <div class="cursor" id="cursor"></div></div>
        <div class="controls">
          <div class="grp">
            <button class="ctl primary" id="bPlay" aria-label="Play or pause">Pause</button>
            <button class="ctl" id="bPrevD" title="Previous drawing  [  or  Shift+←">◂◂ Drawing</button>
            <button class="ctl" id="bPrevF" title="Previous frame  ,  or  ←">◂ Frame</button>
            <button class="ctl" id="bNextF" title="Next frame  .  or  →">Frame ▸</button>
            <button class="ctl" id="bNextD" title="Next drawing  ]  or  Shift+→">Drawing ▸▸</button>
          </div>
          <div class="grp speeds" id="speeds" role="group" aria-label="Playback speed">
            ${[0.1, 0.25, 0.5, 1].map(s => `<button data-s="${s}" class="${s === 1 ? 'on' : ''}">${s}×</button>`).join('')}
          </div>
          <div class="grp">
            <button class="ctl" id="bMute">Sound off</button>
            <label class="check"><input type="checkbox" id="loop" checked> Loop</label>
          </div>
        </div>
        <div class="readout" aria-live="polite">
          <span>Frame <b id="rF">0</b> / <span id="rN">–</span></span>
          <span id="rT">0:00.00</span>
          <span>Drawing <b id="rD">–</b> / <span id="rDN">–</span></span>
          <span id="rH" class="pill">analyzing…</span>
          <span class="dim">${fmtFps(fps)} fps</span>
        </div>
        <div class="film" id="film" aria-label="Drawings"></div>
        <p class="keys">Keys: <kbd>,</kbd> <kbd>.</kbd> or <kbd>←</kbd> <kbd>→</kbd> step a frame · <kbd>[</kbd> <kbd>]</kbd> or <kbd>Shift</kbd>+arrows step a drawing · <kbd>Space</kbd> play · <kbd>1</kbd>–<kbd>4</kbd> speed</p>
      </div>`;
    const v = $('#pv', root), sheet = $('#sheet', root), film = $('#film', root), cursor = $('#cursor', root);
    let N = post.frames || 1, starts = post.starts || null, cur = 0, alive = true;
    let segEls = [], filmEls = [], activeD = -1;
    onLeave(() => { alive = false; v.pause(); v.removeAttribute('src'); v.load(); });

    const holdClass = len => len <= 1 ? 'h1' : len === 2 ? 'h2' : len === 3 ? 'h3' : 'h4';
    const holdLabel = len => len <= 1 ? 'on 1s' : len === 2 ? 'on 2s' : len === 3 ? 'on 3s' : 'held ' + len;
    const lenOf = i => (i + 1 < starts.length ? starts[i + 1] : N) - starts[i];
    function drawingAt(f) {
      if (!starts) return -1;
      let lo = 0, hi = starts.length - 1;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= f) lo = m; else hi = m - 1; }
      return lo;
    }

    function buildSheet() {
      sheet.querySelectorAll('.seg').forEach(e => e.remove());
      film.innerHTML = '';
      segEls = []; filmEls = []; activeD = -1;
      if (!starts) return;
      const frag = document.createDocumentFragment(), ffrag = document.createDocumentFragment();
      starts.forEach((s, i) => {
        const len = lenOf(i);
        const seg = document.createElement('div');
        seg.className = 'seg ' + holdClass(len);
        seg.style.left = (s / N * 100) + '%';
        seg.style.width = (len / N * 100) + '%';
        seg.title = `Drawing ${i + 1} · frame ${s}${len > 1 ? '–' + (s + len - 1) : ''} · ${holdLabel(len)}`;
        frag.appendChild(seg); segEls.push(seg);
        const b = document.createElement('button');
        b.className = 'cel ' + holdClass(len);
        b.innerHTML = `<span class="img"></span><span class="lbl">#${i + 1} <i>${len > 1 ? '×' + len : '×1'}</i></span>`;
        b.title = seg.title;
        b.onclick = () => seekFrame(s);
        ffrag.appendChild(b); filmEls.push(b);
      });
      sheet.insertBefore(frag, cursor);
      film.appendChild(ffrag);
      $('#rDN', root).textContent = starts.length;
      update(cur, true);
    }

    function update(f, force) {
      cur = f;
      $('#rF', root).textContent = f;
      $('#rT', root).textContent = fmtPrecise(f / fps);
      $('#osdF', root).textContent = 'F ' + f;
      cursor.style.left = ((f + 0.5) / N * 100) + '%';
      const d = drawingAt(f);
      if (d >= 0 && (d !== activeD || force)) {
        if (segEls[activeD]) { segEls[activeD].classList.remove('on'); filmEls[activeD].classList.remove('on'); }
        activeD = d;
        segEls[d].classList.add('on'); filmEls[d].classList.add('on');
        const len = lenOf(d);
        $('#rD', root).textContent = d + 1;
        const rH = $('#rH', root); rH.textContent = holdLabel(len); rH.className = 'pill ' + holdClass(len);
        const oH = $('#osdH', root); oH.hidden = false; oH.textContent = holdLabel(len).toUpperCase(); oH.className = holdClass(len);
        if (v.paused) {
          const el = filmEls[d], box = film.getBoundingClientRect(), r = el.getBoundingClientRect();
          if (r.left < box.left || r.right > box.right) film.scrollLeft += r.left - box.left - box.width / 2 + r.width / 2;
        }
      }
    }

    function seekFrame(f) {
      f = Math.max(0, Math.min(N - 1, f));
      v.pause();
      v.currentTime = (f + 0.5) / fps;
      update(f);
    }
    const stepFrame = n => seekFrame(cur + n);
    function stepDrawing(n) {
      if (!starts) return stepFrame(n);
      const d = drawingAt(cur);
      if (n < 0 && cur > starts[d]) return seekFrame(starts[d]);
      const t = Math.max(0, Math.min(starts.length - 1, d + n));
      seekFrame(starts[t]);
    }

    // follow playback
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      const cb = (now, meta) => { if (!alive) return; if (!v.paused) update(Math.min(N - 1, Math.round(meta.mediaTime * fps))); v.requestVideoFrameCallback(cb); };
      v.requestVideoFrameCallback(cb);
    } else {
      const raf = () => { if (!alive) return; if (!v.paused) update(Math.min(N - 1, Math.floor(v.currentTime * fps + 0.01))); requestAnimationFrame(raf); };
      requestAnimationFrame(raf);
    }
    v.addEventListener('loadedmetadata', () => {
      N = post.frames || Math.max(1, Math.round(v.duration * fps));
      $('#rN', root).textContent = N - 1;
      buildSheet();
    });
    const playBtn = $('#bPlay', root);
    const syncPlay = () => { playBtn.textContent = v.paused ? 'Play' : 'Pause'; };
    v.addEventListener('play', syncPlay);
    v.addEventListener('pause', () => { syncPlay(); seekFrame(cur); });
    v.addEventListener('click', () => v.paused ? v.play() : v.pause());
    playBtn.onclick = () => v.paused ? v.play() : v.pause();
    $('#bPrevF', root).onclick = () => stepFrame(-1);
    $('#bNextF', root).onclick = () => stepFrame(1);
    $('#bPrevD', root).onclick = () => stepDrawing(-1);
    $('#bNextD', root).onclick = () => stepDrawing(1);
    const setSpeed = s => {
      v.playbackRate = s;
      $('#speeds', root).querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.s === s));
    };
    $('#speeds', root).addEventListener('click', e => { const b = e.target.closest('button'); if (b) setSpeed(+b.dataset.s); });
    $('#loop', root).onchange = e => { v.loop = e.target.checked; };
    $('#bMute', root).onclick = () => { v.muted = !v.muted; $('#bMute', root).textContent = v.muted ? 'Sound off' : 'Sound on'; };

    // scrub on the timing sheet
    let dragging = false;
    const scrubTo = e => { const r = sheet.getBoundingClientRect(); seekFrame(Math.floor((e.clientX - r.left) / r.width * N)); };
    sheet.addEventListener('pointerdown', e => { dragging = true; sheet.setPointerCapture(e.pointerId); scrubTo(e); });
    sheet.addEventListener('pointermove', e => { if (dragging) scrubTo(e); });
    sheet.addEventListener('pointerup', () => { dragging = false; });

    const onKey = e => {
      if (e.target.closest('input, textarea, select')) return;
      const k = e.key;
      if (k === ',' || (k === 'ArrowLeft' && !e.shiftKey)) stepFrame(-1);
      else if (k === '.' || (k === 'ArrowRight' && !e.shiftKey)) stepFrame(1);
      else if (k === '[' || (k === 'ArrowLeft' && e.shiftKey)) stepDrawing(-1);
      else if (k === ']' || (k === 'ArrowRight' && e.shiftKey)) stepDrawing(1);
      else if (k === ' ' && !e.target.closest('button')) { v.paused ? v.play() : v.pause(); }
      else if ('1234'.includes(k) && k.length === 1) setSpeed([0.1, 0.25, 0.5, 1][+k - 1]);
      else return;
      e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    onLeave(() => document.removeEventListener('keydown', onKey));

    return {
      setStarts(s, n) { starts = s; if (n) N = n; if (v.readyState >= 1) buildSheet(); },
      setThumb(i, src) { const el = filmEls[i] && filmEls[i].querySelector('.img'); if (el) el.style.backgroundImage = `url("${src}")`; },
      setStatus(text) { const rH = $('#rH', root); rH.textContent = text; rH.className = 'pill'; },
      isAlive: () => alive,
    };
  }

  // ---------------- single post ----------------
  async function renderPost(id) {
    const p = await findPost(id);
    if (!p) { view.innerHTML = `<div class="empty">Post ${esc(id)} doesn't exist. <a href="#posts">Back to posts</a></div>`; return; }
    const { url, temp } = await postUrl(p);
    if (temp) onLeave(() => URL.revokeObjectURL(url));
    const score = (p.score || 0) + Votes.get(p.id);
    view.innerHTML = `
      <div class="layout">
        <aside class="side" id="side"></aside>
        <section class="main">
          <div id="player"></div>
          <h1 class="post-title">${esc(p.title)}${p.year ? ' <span class="dim">(' + p.year + ')</span>' : ''}</h1>
          <div id="editBox" hidden>
            <div class="field"><label for="tagEdit">Tags (space separated)</label><textarea id="tagEdit" rows="3"></textarea></div>
            <button class="btn primary" id="saveTags">Save tags</button>
          </div>
        </section>
      </div>`;
    const player = mountPlayer($('#player'), p, url);

    function renderSide(stats) {
      const grouped = TYPE_ORDER.map(type => {
        const ts = p.tags.filter(t => tagType(p, t) === type);
        return ts.length ? `<section><h4>${type}</h4><ul class="taglist">${ts.map(t => tagLink(t, type)).join('')}</ul></section>` : '';
      }).join('');
      const N = p.frames || 1, pct = n => Math.round(100 * (n || 0) / N);
      $('#side').innerHTML = `${grouped}
        <section class="info"><h4>Information</h4><dl>
          <dt>ID</dt><dd>${esc(p.id)}</dd>
          <dt>${p.seed ? 'Released' : 'Posted'}</dt><dd>${p.seed ? p.year : new Date(p.created).toLocaleDateString()}</dd>
          <dt>Size</dt><dd>${p.width}×${p.height}${p.bytes || p.blob ? ' · ' + fmtSize(p.bytes || p.blob.size) : ''}</dd>
          <dt>Frames</dt><dd>${p.frames || '–'} @ ${fmtFps(p.fps)} fps</dd>
          ${p.seed ? `<dt>Source</dt><dd><a href="${esc(p.source)}" target="_blank" rel="noopener">Internet Archive</a>, from ${fmtTime(p.start)}</dd><dt>License</dt><dd>Public domain</dd>`
                   : `<dt>File</dt><dd>${esc(p.sourceName || '—')}</dd>`}
          <dt>Score</dt><dd><span id="score">${score}</span> <button class="vote" id="up" aria-label="Vote up">▲</button></dd>
        </dl></section>
        ${stats ? `<section class="info"><h4>Timing</h4>
          <div class="timingbar"><span class="h1" style="width:${pct(stats.ones)}%"></span><span class="h2" style="width:${pct(stats.twos)}%"></span><span class="h3" style="width:${pct(stats.threes)}%"></span><span class="h4" style="width:${pct(stats.holds)}%"></span></div>
          <div class="legend"><span><i class="h1"></i>1s ${pct(stats.ones)}%</span><span><i class="h2"></i>2s ${pct(stats.twos)}%</span><span><i class="h3"></i>3s ${pct(stats.threes)}%</span><span><i class="h4"></i>held ${pct(stats.holds)}%</span></div>
          <dl><dt>Drawings</dt><dd>${stats.drawings} in ${N} frames</dd></dl>
          <p class="hint">Share of frames by how long each drawing is held.</p></section>` : ''}
        ${p.seed ? '' : `<section><h4>Options</h4><ul class="taglist">
          <li><a href="#" id="edit">Edit tags</a></li>
          <li><button class="btn danger small" id="del">Delete post</button></li></ul></section>`}`;
      $('#up').onclick = () => { Votes.set(p.id, Votes.get(p.id) + 1); $('#score').textContent = (p.score || 0) + Votes.get(p.id); };
      if (!p.seed) {
        $('#del').onclick = async () => {
          const b = $('#del');
          if (!b.dataset.armed) {
            b.dataset.armed = '1'; b.textContent = 'Click again to delete';
            setTimeout(() => { if (b.isConnected) { b.dataset.armed = ''; b.textContent = 'Delete post'; } }, 4000);
            return;
          }
          await Store.del('posts', p.id); location.hash = '#posts';
        };
        $('#edit').onclick = e => {
          e.preventDefault();
          $('#editBox').hidden = false;
          $('#tagEdit').value = p.tags.filter(t => tagType(p, t) === 'general').join(' ');
          $('#tagEdit').focus();
        };
        $('#saveTags').onclick = async () => {
          const keep = p.tags.filter(t => tagType(p, t) !== 'general');
          const gen = $('#tagEdit').value.split(/\s+/).map(normTag).filter(Boolean);
          p.tags = [...new Set([...keep, ...gen])];
          await Store.put('posts', p); route();
        };
      }
    }
    renderSide(p.starts ? timingSummary(p.starts, p.frames) : null);

    if (p.starts) {
      player.setStarts(p.starts, p.frames);
      // drawing thumbnails: cached after the first visit
      const key = 'thumbs:' + p.id + ':' + p.starts.length;
      const cached = await Store.get('cache', key).catch(() => null);
      if (cached) cached.thumbs.forEach((t, i) => player.setThumb(i, t));
      else {
        drawingThumbs(url, p.fps, p.starts, (i, t) => player.setThumb(i, t), player.isAlive)
          .then(th => th && Store.put('cache', { key, thumbs: th }).catch(() => {}))
          .catch(() => {});
      }
    }
  }

  // ---------------- tags / about ----------------
  async function renderTags() {
    const tags = tagCounts(await allPosts());
    view.innerHTML = `<h2>Tags</h2><div class="tablewrap"><table class="tagtable"><thead><tr><th>Posts</th><th>Name</th><th>Type</th></tr></thead><tbody>
      ${tags.map(([t, c]) => `<tr><td>${c.n}</td><td><a class="tag-${c.type}" href="#posts" data-tag="${esc(t)}">${esc(t)}</a></td><td>${c.type}</td></tr>`).join('')}
      </tbody></table></div>`;
  }
  async function renderAbout() {
    const s = await seeds();
    view.innerHTML = `<div class="prose">
      <h2>Frame by frame, drawing by drawing</h2>
      <p>Sakugify is a small animation gallery in the spirit of animation-appreciation boorus. Every post opens in a player built for studying
      animation: step one frame at a time, jump straight to the next drawing, slow playback down to 0.1×, and read the timing sheet.</p>
      <dl>
        <dt>Drawings and timing</dt><dd>When a clip is posted, every frame is compared with the one before it. A frame that changes starts a new drawing;
          a frame that doesn't is the same drawing held. That gives the timing: drawings held for one frame are <b class="tag-h1">on 1s</b>,
          two frames <b class="tag-h2">on 2s</b>, three frames <b class="tag-h3">on 3s</b>, longer is a <b class="tag-h4">hold</b>.
          The colored sheet under the video shows every drawing at its real length.</dd>
        <dt>Keys</dt><dd><kbd>,</kbd> <kbd>.</kbd> or the arrow keys step a frame. <kbd>[</kbd> <kbd>]</kbd> or Shift + arrows step a drawing.
          <kbd>Space</kbd> plays and pauses, <kbd>1</kbd>–<kbd>4</kbd> set the speed. Drag across the timing sheet to scrub.</dd>
        <dt>Camera moves</dt><dd>A pan over a held drawing changes every frame, so it reads as animation on 1s. Step through it to see what's really drawn.</dd>
        <dt>Your uploads</dt><dd>Clips you post stay in this browser only (IndexedDB). They are never uploaded anywhere.</dd>
      </dl>
      <h2>The starter collection</h2>
      <p>The gallery comes with short excerpts from public-domain animation, pulled from the Internet Archive. Telecined TV transfers were
      converted back to their original 24 film frames so stepping lands on real drawings.</p>
      <div class="tablewrap"><table class="tagtable"><thead><tr><th>Film</th><th>Year</th><th>Excerpt</th></tr></thead><tbody>
        ${s.map(p => `<tr><td><a href="#post-${p.id}">${esc(p.title)}</a></td><td>${p.year}</td><td><a href="${esc(p.source)}" target="_blank" rel="noopener">${fmtTime(p.start)}–${fmtTime(p.start + p.duration)}</a></td></tr>`).join('')}
      </tbody></table></div>
    </div>`;
  }

  // ---------------- upload ----------------
  function renderUpload() {
    view.innerHTML = `
      <div class="upload">
        <section class="stage">
          <label class="drop" id="drop">
            <input type="file" id="file" accept="video/*" hidden>
            <span class="big" aria-hidden="true">▶</span>
            <strong>Drop an animation clip here</strong>
            <span>or click to choose a file. Short cuts (under a minute) work best.</span>
          </label>
          <div id="preview" hidden></div>
        </section>
        <aside class="panel">
          <h3>New post</h3>
          <div class="field"><label for="title">Title</label><input id="title" placeholder="Untitled cut"></div>
          <div class="field"><label for="artist">Animator (artist)</label><input id="artist" placeholder="Leave blank if unknown"></div>
          <div class="field"><label for="copyright">Series or film (copyright)</label><input id="copyright" placeholder="original"></div>
          <div class="field"><label for="tags">Tags</label><textarea id="tags" rows="3" placeholder="effects smears fighting hair"></textarea></div>
          <div class="field"><label for="fps">Frame rate <output id="fpsNote"></output></label>
            <select id="fps">${FPS_CHOICES.map(f => `<option value="${f}" ${f === 24 ? 'selected' : ''}>${f} fps</option>`).join('')}</select></div>
          <p class="hint">Timing tags (on 1s / 2s / 3s) are added automatically when the clip is analyzed.</p>
          <button class="btn primary wide" id="post" disabled>Analyze &amp; post</button>
          <div class="progress" hidden id="prog"><div id="bar"></div></div>
          <div class="status" id="status"></div>
        </aside>
      </div>`;
    let file = null, url = null, alive = true, video = null;
    onLeave(() => { alive = false; if (video) video.pause(); if (url) URL.revokeObjectURL(url); });
    const statusEl = $('#status'), drop = $('#drop');
    $('#file').addEventListener('change', e => e.target.files[0] && load(e.target.files[0]));
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) load(f); });

    function load(f) {
      if (!f.type.startsWith('video/') && !/\.(mp4|webm|mov|mkv|m4v|ogv)$/i.test(f.name)) { statusEl.textContent = 'That file isn\'t a video. Choose an MP4, WebM or MOV clip.'; return; }
      file = f;
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(f);
      const pv = $('#preview');
      pv.hidden = false;
      pv.innerHTML = `<video id="upv" src="${url}" controls muted loop autoplay playsinline></video>
        <button class="btn" id="other">Choose another clip</button>`;
      video = $('#upv');
      $('#other').onclick = () => $('#file').click();
      drop.hidden = true;
      if (!$('#title').value) $('#title').value = f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
      video.onerror = () => { statusEl.textContent = 'This browser can\'t play that file. Try MP4 (H.264) or WebM.'; };
      video.onloadedmetadata = async () => {
        $('#post').disabled = false;
        statusEl.textContent = `${video.videoWidth}×${video.videoHeight} · ${fmtTime(video.duration)}`;
        const fps = await detectFps(video);
        if (fps && alive) { $('#fps').value = String(fps); $('#fpsNote').textContent = 'detected'; }
      };
    }

    $('#post').onclick = async () => {
      if (!file) return;
      const fps = +$('#fps').value;
      $('#post').disabled = true; $('#prog').hidden = false;
      statusEl.textContent = 'Reading every frame to find the drawings…';
      try {
        const r = await analyzeClip(url, fps, x => { $('#bar').style.width = (x * 100).toFixed(1) + '%'; }, () => alive);
        const tags = [], tagTypes = {};
        const add = (t, type) => { t = normTag(t); if (t && !tags.includes(t)) { tags.push(t); tagTypes[t] = type; } };
        const artist = $('#artist').value.trim();
        add(artist || 'artist_unknown', 'artist');
        add($('#copyright').value.trim() || 'original', 'copyright');
        timingTags(timingSummary(r.starts, r.N), r.N).forEach(t => add(t, 'meta'));
        add('animated', 'general');
        $('#tags').value.split(/\s+/).forEach(t => add(t, 'general'));
        const id = await Store.put('posts', {
          title: $('#title').value.trim() || 'Untitled cut', artist, tags, tagTypes, created: Date.now(),
          blob: file, mime: file.type, thumb: r.poster, score: 0, duration: r.N / fps, fps, frames: r.N, starts: r.starts,
          width: video.videoWidth, height: video.videoHeight, sourceName: file.name,
        });
        location.hash = '#post-' + id;
      } catch (e) {
        if (!alive) return;
        statusEl.textContent = e.message === 'cancelled' ? 'Cancelled.' : 'Couldn\'t analyze this clip: ' + e.message;
        $('#post').disabled = false; $('#prog').hidden = true;
      }
    };
  }

  route();
})();
