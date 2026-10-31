/* Sakugify — a local, booru-style gallery where every clip becomes sakuga. */
(function () {
  'use strict';

  // ---------- storage (IndexedDB, local to this browser) ----------
  const DB = {
    db: null,
    open() {
      if (this.db) return Promise.resolve(this.db);
      return new Promise((res, rej) => {
        const r = indexedDB.open('sakugify', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('posts', { keyPath: 'id', autoIncrement: true });
        r.onsuccess = () => { this.db = r.result; res(this.db); };
        r.onerror = () => rej(r.error);
      });
    },
    async run(mode, fn) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const tx = db.transaction('posts', mode);
        const req = fn(tx.objectStore('posts'));
        tx.oncomplete = () => res(req && req.result);
        tx.onerror = () => rej(tx.error);
      });
    },
    all() { return this.run('readonly', s => s.getAll()); },
    get(id) { return this.run('readonly', s => s.get(id)); },
    put(p) { return this.run('readwrite', s => s.put(p)); },
    del(id) { return this.run('readwrite', s => s.delete(id)); },
  };

  // ---------- helpers ----------
  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const normTag = s => String(s || '').trim().toLowerCase().replace(/\s+/g, '_').replace(/[^\p{L}\p{N}_\-:().!?']/gu, '');
  const fmtTime = s => { s = Math.max(0, s || 0); return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'); };
  const fmtSize = b => b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB';
  const view = $('#view');
  let cleanup = [];
  const onLeave = fn => cleanup.push(fn);

  const TYPE_ORDER = ['artist', 'copyright', 'meta', 'general'];
  const tagType = (post, t) => (post.tagTypes && post.tagTypes[t]) || 'general';
  const tagLink = (t, type, count) =>
    `<li><a class="q" href="#/posts?tags=${encodeURIComponent(t)}" title="Search only this tag">?</a>
      <a class="tag-${type}" href="#/posts?tags=${encodeURIComponent(t)}">${esc(t.replace(/_/g, ' '))}</a>
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

  // ---------- router ----------
  function route() {
    cleanup.forEach(fn => { try { fn(); } catch (e) { /* ignore */ } });
    cleanup = [];
    const h = location.hash.slice(1) || '/posts';
    const [path, qs] = h.split('?');
    const params = new URLSearchParams(qs || '');
    const section = path.split('/')[1] || 'posts';
    document.querySelectorAll('[data-nav]').forEach(a =>
      a.classList.toggle('active', a.dataset.nav === (section === 'post' ? 'posts' : section)));
    $('#topSearch input').value = params.get('tags') || '';
    window.scrollTo(0, 0);
    if (section === 'post') return renderPost(+path.split('/')[2]);
    if (section === 'upload') return renderUpload();
    if (section === 'tags') return renderTags();
    if (section === 'about') return renderAbout();
    return renderPosts(params.get('tags') || '');
  }
  window.addEventListener('hashchange', route);
  $('#topSearch').addEventListener('submit', e => {
    e.preventDefault();
    location.hash = '#/posts?tags=' + encodeURIComponent($('#topSearch input').value.trim());
  });

  // ---------- posts list ----------
  async function renderPosts(query) {
    const all = (await DB.all()).sort((a, b) => b.id - a.id);
    const posts = query ? all.filter(p => matches(p, query)) : all;
    const tags = tagCounts(posts).slice(0, 40);
    view.innerHTML = `
      <div class="layout">
        <aside class="side">
          <section><h4>Search</h4>
            <form class="side-search" id="sideSearch"><input name="q" value="${esc(query)}" placeholder="tags"></form></section>
          <section><h4>Tags</h4><ul class="taglist">${tags.map(([t, c]) => tagLink(t, c.type, c.n)).join('') || '<li class="count">No tags yet</li>'}</ul></section>
        </aside>
        <section>
          ${posts.length ? `<div class="grid">${posts.map(p => `
            <a class="thumb" href="#/post/${p.id}" data-id="${p.id}" title="${esc(p.title)} — ${esc(p.tags.join(' '))}">
              <img src="${p.thumb}" alt="${esc(p.title)}" loading="lazy">
              <span class="badge">${fmtTime(p.duration)}</span>
              <span class="badge score">▲ ${p.score || 0}</span>
            </a>`).join('')}</div>`
          : `<div class="empty">${all.length ? 'No posts match <b>' + esc(query) + '</b>.'
              : '<b>Nothing here yet.</b><br>Upload any video clip and it will be re-animated as sakuga.<br>'}
              <br><a class="btn primary" href="#/upload">Upload a clip</a></div>`}
        </section>
      </div>`;
    $('#sideSearch').addEventListener('submit', e => {
      e.preventDefault();
      location.hash = '#/posts?tags=' + encodeURIComponent(e.target.q.value.trim());
    });
    // hover preview
    const byId = new Map(posts.map(p => [p.id, p]));
    view.querySelectorAll('.thumb').forEach(a => {
      let vid, url;
      a.addEventListener('mouseenter', () => {
        const p = byId.get(+a.dataset.id);
        url = URL.createObjectURL(p.blob);
        vid = Object.assign(document.createElement('video'), { src: url, muted: true, loop: true, autoplay: true, playsInline: true });
        a.appendChild(vid);
      });
      a.addEventListener('mouseleave', () => { if (vid) { vid.remove(); URL.revokeObjectURL(url); vid = null; } });
    });
  }

  // ---------- single post ----------
  async function renderPost(id) {
    const p = await DB.get(id);
    if (!p) { view.innerHTML = `<div class="empty">Post #${id} doesn't exist. <a href="#/posts">Back to posts</a></div>`; return; }
    const url = URL.createObjectURL(p.blob);
    onLeave(() => URL.revokeObjectURL(url));
    const st = p.stats || {};
    const tot = (st.ones + st.twos + st.threes) || 1;
    const pct = n => Math.round(100 * (n || 0) / tot);
    const grouped = TYPE_ORDER.map(type => {
      const ts = p.tags.filter(t => tagType(p, t) === type);
      return ts.length ? `<section><h4>${type}</h4><ul class="taglist">${ts.map(t => tagLink(t, type)).join('')}</ul></section>` : '';
    }).join('');
    view.innerHTML = `
      <div class="layout">
        <aside class="side">
          ${grouped}
          <section class="info"><h4>Information</h4><dl>
            <dt>ID</dt><dd>${p.id}</dd>
            <dt>Posted</dt><dd>${new Date(p.created).toLocaleString()}</dd>
            <dt>Size</dt><dd>${p.width}×${p.height} · ${fmtSize(p.blob.size)}</dd>
            <dt>Length</dt><dd>${fmtTime(p.duration)}</dd>
            <dt>Source</dt><dd>${esc(p.sourceName || '—')}</dd>
            <dt>Score</dt><dd><span id="score">${p.score || 0}</span> <button class="vote" id="up" title="Vote up">▲</button></dd>
          </dl></section>
          <section class="info"><h4>Timing</h4>
            <div class="timingbar"><span style="width:${pct(st.ones)}%"></span><span style="width:${pct(st.twos)}%"></span><span style="width:${pct(st.threes)}%"></span></div>
            <div class="legend"><i style="background:var(--accent)"></i>1s ${pct(st.ones)}% <i style="background:var(--accent2)"></i>2s ${pct(st.twos)}% <i style="background:var(--t-general)"></i>3s ${pct(st.threes)}%</div>
            <dl style="margin-top:8px"><dt>Drawings</dt><dd>${st.drawings || 0}</dd><dt>Impact frames</dt><dd>${st.impacts || 0}</dd><dt>Smears</dt><dd>${st.smears || 0}</dd></dl>
          </section>
          <section><h4>Options</h4><ul class="taglist">
            <li><a href="${url}" download="${esc(normTag(p.title) || 'sakuga')}_${p.id}.${p.mime.includes('mp4') ? 'mp4' : 'webm'}">Download</a></li>
            <li><a href="#" id="edit">Edit tags</a></li>
            <li><a href="#" id="del" class="btn danger" style="padding:2px 8px;margin-top:4px">Delete</a></li>
          </ul></section>
        </aside>
        <section>
          <div class="post-media"><video id="pv" src="${url}" controls loop autoplay playsinline></video></div>
          <h1 class="post-title">${esc(p.title)}</h1>
          <div class="legend" style="margin:0">${p.artist ? 'Key animation by <span class="tag-artist">' + esc(p.artist) + '</span> · ' : ''}${esc(p.tags.length)} tags</div>
          <div id="editBox" hidden style="margin-top:14px">
            <div class="field"><label>Tags (space separated)</label><textarea id="tagEdit" rows="3"></textarea></div>
            <button class="btn primary" id="saveTags">Save tags</button>
          </div>
        </section>
      </div>`;
    fixWebmDuration($('#pv'));
    $('#up').onclick = async () => { p.score = (p.score || 0) + 1; await DB.put(p); $('#score').textContent = p.score; };
    $('#del').onclick = async e => {
      e.preventDefault();
      if (!confirm('Delete post #' + p.id + '? This cannot be undone.')) return;
      await DB.del(p.id); location.hash = '#/posts';
    };
    $('#edit').onclick = e => {
      e.preventDefault();
      $('#editBox').hidden = false;
      $('#tagEdit').value = p.tags.filter(t => tagType(p, t) === 'general').join(' ');
    };
    $('#saveTags').onclick = async () => {
      const keep = p.tags.filter(t => tagType(p, t) !== 'general');
      const gen = $('#tagEdit').value.split(/\s+/).map(normTag).filter(Boolean);
      p.tags = [...new Set([...keep, ...gen])];
      await DB.put(p); route();
    };
  }

  // MediaRecorder WebM files have no duration header; nudging fixes seeking.
  function fixWebmDuration(v) {
    v.addEventListener('loadedmetadata', function once() {
      if (v.duration === Infinity) {
        v.currentTime = 1e101;
        v.addEventListener('timeupdate', function back() {
          v.removeEventListener('timeupdate', back); v.currentTime = 0;
        });
      }
      v.removeEventListener('loadedmetadata', once);
    });
  }

  // ---------- tags ----------
  async function renderTags() {
    const tags = tagCounts(await DB.all());
    view.innerHTML = `<h2>Tags</h2>${tags.length ? `<table class="tagtable"><tr><th>Posts</th><th>Name</th><th>Type</th></tr>
      ${tags.map(([t, c]) => `<tr><td>${c.n}</td><td><a class="tag-${c.type}" href="#/posts?tags=${encodeURIComponent(t)}">${esc(t)}</a></td><td>${c.type}</td></tr>`).join('')}
      </table>` : '<div class="empty">No tags yet — they appear once you post clips.</div>'}`;
  }

  // ---------- about ----------
  function renderAbout() {
    view.innerHTML = `<div class="prose">
      <h2>Every clip, sakuga.</h2>
      <p>Sakugify re-animates any video as if a key animator drew it: it decides frame timing, cel-shades and inks every drawing,
      adds smears on fast motion and slams in impact frames on hits. Everything runs on your GPU in this browser tab — your clips
      never leave your device. Posts are stored locally (IndexedDB) in this browser.</p>
      <h2>What the engine does</h2>
      <dl>
        <dt>Timing — on 1s / 2s / 3s</dt><dd>Animation is drawn at 24fps but each drawing is usually held for 2 or 3 frames.
          In <b>Auto</b> mode the hold follows the motion, like real key animation: explosive action goes on ones, acting on twos,
          quiet moments on threes. The output HUD shows the current timing live.</dd>
        <dt>Cel shading &amp; line art</dt><dd>Light is posterized into flat bands with tinted shadows and blown-out highlights,
          and edges are inked from a Sobel filter.</dd>
        <dt>Smears &amp; multiples</dt><dd>Moving regions are stretched along their motion vector and onion-skinned with the previous drawing.</dd>
        <dt>Impact frames</dt><dd>Sudden motion spikes trigger two alternating two-tone frames (black/cream, then cream/red),
          radial speed lines, camera shake and a zoom punch.</dd>
        <dt>Styles</dt><dd><b>TV anime</b> (clean modern cels), <b>90s cel</b> (warm film grade, grain, vignette),
          <b>Genga</b> (key-animation pencil drawing on paper, red/blue shadow lines), <b>Manga ink</b> (screentone).</dd>
        <dt>Framing</dt><dd>Optional cinemascope letterbox, film grain and shake — the camera moves on the same timing as the drawings.</dd>
      </dl>
      <h2>Tips</h2>
      <p>Short clips (3–20s) with clear action work best. Rendering runs in real time, so keep this tab visible while it records.
      Output is WebM (Chrome/Firefox/Edge) or MP4 (Safari).</p>
    </div>`;
  }

  // ---------- upload / sakuga-fy ----------
  function renderUpload() {
    const D = SakugaEngine.DEFAULTS;
    const slider = (id, label, min, max, step, val) => `
      <div class="field"><label for="${id}">${label}<output id="${id}_o">${val}</output></label>
      <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}"></div>`;
    view.innerHTML = `
      <div class="upload">
        <aside class="panel">
          <h3>Style</h3>
          <div class="field"><select id="style">
            <option value="tv">TV anime</option><option value="cel90">90s cel</option>
            <option value="genga">Genga (key drawing)</option><option value="ink">Manga ink</option></select></div>
          <h3>Timing</h3>
          <div class="seg" id="timing">
            <button data-v="auto" class="on" title="Varies with motion">Auto</button><button data-v="1">1s</button><button data-v="2">2s</button><button data-v="3">3s</button></div>
          <h3>Drawing</h3>
          ${slider('bands', 'Shade bands', 2, 6, 1, D.bands)}
          ${slider('line', 'Line weight', 0, 1.5, 0.05, D.line)}
          ${slider('sat', 'Color saturation', 0.5, 2, 0.05, D.sat)}
          <h3>Action</h3>
          ${slider('smear', 'Smears', 0, 1.5, 0.05, D.smear)}
          ${slider('impact', 'Impact frame sensitivity', 0, 1, 0.05, D.impact)}
          <label class="check"><input type="checkbox" id="speedLines" checked> Speed lines</label>
          <label class="check"><input type="checkbox" id="shake" checked> Camera shake &amp; zoom punch</label>
          <h3>Framing</h3>
          <div class="field"><label for="letterbox">Letterbox</label><select id="letterbox">
            <option value="none">None</option><option value="1.85">1.85 : 1</option><option value="2.39">2.39 : 1 cinemascope</option></select></div>
          ${slider('grain', 'Film grain', 0, 0.2, 0.01, D.grain)}
        </aside>

        <section class="stage">
          <label class="drop" id="drop">
            <input type="file" id="file" accept="video/*" hidden>
            <div><div class="big">▶</div><strong>Drop a video clip here</strong>or click to choose a file — any clip, any format your browser plays</div>
          </label>
          <div id="screens" class="screens" hidden>
            <figure><canvas id="out"></canvas><figcaption>Sakuga</figcaption>
              <div class="hud"><span id="hudImp" class="imp" hidden>IMPACT</span><span id="hudSmear" hidden>SMEAR</span><span id="hudHold" class="on2">ON 2s</span></div></figure>
            <figure class="src"><video id="src" playsinline muted loop></video><figcaption>Source</figcaption></figure>
          </div>
          <div class="transport" id="transport" hidden>
            <button class="btn" id="play">❚❚ Pause</button>
            <button class="btn" id="mute">🔇 Muted</button>
            <span class="trim">Trim <input type="number" id="tStart" min="0" step="0.1" value="0"> to <input type="number" id="tEnd" min="0" step="0.1" value="0"> s</span>
            <button class="btn" id="other">Choose another clip</button>
          </div>
          <div class="progress"><div id="bar"></div></div>
          <div class="status" id="status"></div>
        </section>

        <aside class="panel">
          <h3>Post</h3>
          <div class="field"><label for="title">Title</label><input id="title" placeholder="Untitled cut"></div>
          <div class="field"><label for="artist">Key animator (artist)</label><input id="artist" placeholder="you?"></div>
          <div class="field"><label for="copyright">Series / source (copyright)</label><input id="copyright" placeholder="original"></div>
          <div class="field"><label for="tags">Extra tags</label><textarea id="tags" rows="2" placeholder="fighting running hair"></textarea></div>
          <div class="legend" style="margin:0 0 12px">Timing, smears, impact frames &amp; style tags are added automatically.</div>
          <h3>Live analysis</h3>
          <div class="stats" id="stats"></div>
          <div class="actions">
            <button class="btn primary" id="post" disabled>Sakuga-fy &amp; post</button>
            <button class="btn" id="dl" disabled>Render &amp; download only</button>
            <button class="btn" id="cancel" hidden>Cancel render</button>
          </div>
        </aside>
      </div>`;

    const canvas = $('#out'), video = $('#src'), statusEl = $('#status'), bar = $('#bar');
    let engine;
    try { engine = new SakugaEngine(canvas); }
    catch (e) { view.innerHTML = `<div class="empty">Couldn't start the GPU engine: ${esc(e.message)}</div>`; return; }

    let alive = true, fileUrl = null, file = null, rendering = null, audio = null;
    let tStart = 0, tEnd = 0;
    onLeave(() => {
      alive = false;
      if (rendering) rendering.abort();
      video.pause(); if (fileUrl) URL.revokeObjectURL(fileUrl);
      if (audio) audio.ctx.close();
    });

    // --- settings ---
    const P = engine.params;
    const refresh = () => { if (video.paused && engine.W) engine.rerender(video); };
    ['bands', 'line', 'sat', 'smear', 'impact', 'grain'].forEach(id => {
      const el = $('#' + id);
      el.addEventListener('input', () => { P[id] = +el.value; $('#' + id + '_o').textContent = el.value; refresh(); });
    });
    ['style', 'letterbox'].forEach(id => $('#' + id).addEventListener('change', e => { P[id] = e.target.value; refresh(); }));
    ['speedLines', 'shake'].forEach(id => $('#' + id).addEventListener('change', e => { P[id] = e.target.checked; }));
    $('#timing').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      $('#timing').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      P.timing = b.dataset.v;
    });

    // --- file loading ---
    const drop = $('#drop');
    $('#file').addEventListener('change', e => e.target.files[0] && load(e.target.files[0]));
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) load(f); });
    $('#other').onclick = () => $('#file').click();

    function load(f) {
      if (!f.type.startsWith('video/') && !/\.(mp4|webm|mov|mkv|m4v|ogv)$/i.test(f.name)) { statusEl.textContent = 'That doesn\'t look like a video file.'; return; }
      file = f;
      if (fileUrl) URL.revokeObjectURL(fileUrl);
      fileUrl = URL.createObjectURL(f);
      statusEl.textContent = 'Loading…';
      video.src = fileUrl;
      video.onerror = () => { statusEl.textContent = 'Your browser can\'t decode this video. Try MP4 (H.264) or WebM.'; };
      video.onloadedmetadata = () => {
        engine.setSource(video);
        tStart = 0; tEnd = Math.round(video.duration * 10) / 10;
        $('#tStart').value = 0; $('#tEnd').value = tEnd; $('#tEnd').max = tEnd; $('#tStart').max = tEnd;
        if (!$('#title').value) $('#title').value = f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
        drop.hidden = true; $('#screens').hidden = false; $('#transport').hidden = false;
        $('#post').disabled = $('#dl').disabled = false;
        statusEl.textContent = `${video.videoWidth}×${video.videoHeight} · ${fmtTime(video.duration)} — previewing live. Tweak settings, then post.`;
        video.play().catch(() => {});
        updatePlay();
      };
    }

    $('#tStart').addEventListener('change', e => { tStart = Math.max(0, Math.min(+e.target.value || 0, tEnd - 0.2)); e.target.value = tStart; video.currentTime = tStart; });
    $('#tEnd').addEventListener('change', e => { tEnd = Math.min(video.duration, Math.max(+e.target.value || 0, tStart + 0.2)); e.target.value = tEnd; });

    const updatePlay = () => { $('#play').textContent = video.paused ? '▶ Play' : '❚❚ Pause'; };
    $('#play').onclick = () => { video.paused ? video.play() : video.pause(); };
    video.addEventListener('play', updatePlay); video.addEventListener('pause', updatePlay);
    $('#mute').onclick = () => { video.muted = !video.muted; $('#mute').textContent = video.muted ? '🔇 Muted' : '🔊 Sound on'; };

    // --- frame loop ---
    const hudHold = $('#hudHold'), hudImp = $('#hudImp'), hudSmear = $('#hudSmear'), statsEl = $('#stats');
    let lastStats = 0;
    function onFrame(t) {
      if (t >= tEnd - 0.01 || t < tStart - 0.05) {
        if (rendering) { rendering.finish(); return; }
        if (t >= tEnd - 0.01) { video.currentTime = tStart; return; }
      }
      if (engine.frame(video, t)) {
        const i = engine.info;
        hudHold.textContent = 'ON ' + i.hold + 's'; hudHold.className = 'on' + i.hold;
        hudImp.hidden = !i.impact; hudSmear.hidden = !(i.smear > 0.4) || i.impact;
        if (rendering) rendering.progress(t);
      }
      const now = performance.now();
      if (now - lastStats > 250) {
        lastStats = now;
        const s = engine.stats;
        statsEl.innerHTML = `<span>Drawings</span><b>${s.drawings}</b><span>On 1s / 2s / 3s</span><b>${s.ones} / ${s.twos} / ${s.threes}</b>
          <span>Impact frames</span><b>${s.impacts}</b><span>Smears</span><b>${s.smears}</b><span>Motion</span><b>${(engine.info.motion * 100).toFixed(1)}</b>`;
      }
    }
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      const cb = (now, meta) => { if (!alive) return; onFrame(meta.mediaTime); video.requestVideoFrameCallback(cb); };
      video.requestVideoFrameCallback(cb);
    } else {
      let lastT = -1;
      const raf = () => { if (!alive) return; if (video.currentTime !== lastT && video.readyState >= 2) { lastT = video.currentTime; onFrame(lastT); } requestAnimationFrame(raf); };
      requestAnimationFrame(raf);
    }

    // --- thumbnail capture at the most energetic drawing ---
    const thumb = document.createElement('canvas');
    const grabThumb = () => {
      thumb.width = 360; thumb.height = Math.round(360 * canvas.height / canvas.width);
      thumb.getContext('2d').drawImage(canvas, 0, 0, thumb.width, thumb.height);
    };

    // --- rendering ---
    function pickMime() {
      const c = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4;codecs=avc1,mp4a', 'video/mp4'];
      return c.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
    }
    function ensureAudio() {
      if (audio) return audio;
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const src = ctx.createMediaElementSource(video);
        const dest = ctx.createMediaStreamDestination();
        src.connect(dest); src.connect(ctx.destination);
        audio = { ctx, dest };
      } catch (e) { audio = { ctx: { close() {}, resume() {} }, dest: null }; }
      return audio;
    }
    const seek = t => new Promise(r => { video.addEventListener('seeked', r, { once: true }); video.currentTime = t; });

    async function renderClip() {
      if (!window.MediaRecorder) throw new Error('This browser cannot record video (MediaRecorder missing).');
      const a = ensureAudio();
      if (a.ctx.resume) await a.ctx.resume();
      const wasMuted = video.muted;
      video.pause(); video.loop = false; video.muted = false;
      await seek(tStart);
      engine.reset();
      engine.onPeak = grabThumb;
      thumb.width = 0;

      const stream = canvas.captureStream(30);
      if (a.dest) a.dest.stream.getAudioTracks().forEach(tr => stream.addTrack(tr));
      const mime = pickMime();
      const rec = new MediaRecorder(stream, Object.assign({ videoBitsPerSecond: 8e6 }, mime ? { mimeType: mime } : {}));
      const chunks = [];
      rec.ondataavailable = e => e.data.size && chunks.push(e.data);

      return new Promise((resolve, reject) => {
        let done = false;
        const end = aborted => {
          if (done) return; done = true;
          rendering = null;
          video.pause(); video.loop = true; video.muted = wasMuted;
          engine.onPeak = null;
          video.removeEventListener('ended', onEnded);
          rec.onstop = () => {
            stream.getVideoTracks().forEach(t => t.stop());
            if (aborted) return reject(new Error('cancelled'));
            if (!thumb.width) grabThumb();
            resolve({ blob: new Blob(chunks, { type: (rec.mimeType || mime || 'video/webm').split(';')[0] }), thumb: thumb.toDataURL('image/jpeg', 0.85), stats: Object.assign({}, engine.stats) });
          };
          rec.state !== 'inactive' ? rec.stop() : rec.onstop();
        };
        const onEnded = () => end(false);
        video.addEventListener('ended', onEnded);
        rendering = {
          finish: () => end(false),
          abort: () => end(true),
          progress: t => { bar.style.width = Math.min(100, 100 * (t - tStart) / (tEnd - tStart)) + '%'; },
        };
        rec.start(250);
        video.play().catch(err => { end(true); reject(err); });
      });
    }

    function autoTags(st) {
      const tot = (st.ones + st.twos + st.threes) || 1;
      const t = ['animated', 'sakuga'];
      const meta = [];
      meta.push({ tv: 'cel_shading', cel90: 'retro', genga: 'genga', ink: 'manga_ink' }[P.style]);
      if (P.style === 'cel90') meta.push('cel_shading');
      if (P.timing === 'auto') meta.push('variable_timing'); else meta.push('on_' + P.timing + 's');
      if (st.ones / tot > 0.4) t.push('full_animation');
      if (st.threes / tot > 0.5) t.push('limited_animation');
      if (st.smears >= 3) t.push('smears');
      if (st.impacts >= 1) t.push('impact_frames');
      if (st.impacts >= 3) t.push('fighting');
      if (st.impacts >= 1 && P.speedLines) t.push('speed_lines');
      if (st.impacts >= 1 && P.shake) t.push('camera_shake');
      if (st.pans / (st.drawings || 1) > 0.3) t.push('background_animation');
      if (st.motionSum / (st.drawings || 1) < 0.012 && st.impacts === 0) t.push('character_acting');
      if (st.motionSum / (st.drawings || 1) > 0.04) t.push('effects');
      if (P.letterbox !== 'none') meta.push('letterbox');
      return { general: t, meta };
    }

    async function go(postIt) {
      const btns = ['#post', '#dl', '#other', '#play', '#tStart', '#tEnd'].map(s => $(s));
      btns.forEach(b => b.disabled = true);
      $('#cancel').hidden = false;
      statusEl.textContent = 'Rendering in real time — keep this tab visible…';
      bar.style.width = '0%';
      try {
        const r = await renderClip();
        bar.style.width = '100%';
        if (!postIt) {
          const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(r.blob), download: (normTag($('#title').value) || 'sakuga') + (r.blob.type.includes('mp4') ? '.mp4' : '.webm') });
          a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
          statusEl.textContent = 'Done — downloaded.';
          return;
        }
        const tagTypes = {};
        const tags = [];
        const add = (tg, type) => { tg = normTag(tg); if (tg && !tags.includes(tg)) { tags.push(tg); tagTypes[tg] = type; } };
        const artist = $('#artist').value.trim();
        add(artist || 'artist_unknown', 'artist');
        add($('#copyright').value.trim() || 'original', 'copyright');
        const at = autoTags(r.stats);
        at.meta.forEach(x => add(x, 'meta'));
        at.general.forEach(x => add(x, 'general'));
        $('#tags').value.split(/\s+/).forEach(x => add(x, 'general'));
        const id = await DB.put({
          title: $('#title').value.trim() || 'Untitled cut', artist, tags, tagTypes, created: Date.now(),
          blob: r.blob, mime: r.blob.type, thumb: r.thumb, score: 0, duration: tEnd - tStart,
          width: canvas.width, height: canvas.height, stats: r.stats, sourceName: file ? file.name : '', settings: Object.assign({}, P),
        });
        location.hash = '#/post/' + id;
      } catch (e) {
        statusEl.textContent = e.message === 'cancelled' ? 'Render cancelled.' : 'Render failed: ' + e.message;
        bar.style.width = '0%';
      } finally {
        if (alive) { btns.forEach(b => b.disabled = false); $('#cancel').hidden = true; video.play().catch(() => {}); }
      }
    }
    $('#post').onclick = () => go(true);
    $('#dl').onclick = () => go(false);
    $('#cancel').onclick = () => rendering && rendering.abort();
  }

  route();
})();
