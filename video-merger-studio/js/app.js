/* ==========================================================================
   Video Merger Studio — app.js  (UI logic)
   ========================================================================== */
(function () {
  'use strict';

  /* ---------- helpers ---------------------------------------------------- */
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const VIDEO_EXT = /\.(mp4|m4v|mov|mkv|avi|wmv|flv|webm|mpg|mpeg|vob|dat|ts|mts|m2ts|3gp|3g2|ogv|asf|divx|mxf)$/i;
  let uidCounter = 0;
  const uid = () => 'c' + (++uidCounter);

  function h(tag, attrs) {
    const el = document.createElement(tag);
    for (const k in (attrs || {})) {
      const v = attrs[k];
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (let i = 2; i < arguments.length; i++) {
      const c = arguments[i];
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }
  const icon = (id) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + id);
    svg.appendChild(use);
    return svg;
  };
  const fmtTime = (s) => {
    if (!isFinite(s) || s <= 0) return '0:00';
    s = Math.round(s);
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    return (hh ? hh + ':' + String(mm).padStart(2, '0') : mm) + ':' + String(ss).padStart(2, '0');
  };
  const fmtSize = (b) => b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';
  const extOf = (n) => ((/\.([a-z0-9]+)$/i.exec(n) || [])[1] || '').toUpperCase();

  function toast(msg) {
    const t = h('div', { class: 'toast', text: msg });
    $('#toasts').appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 350); }, 3200);
  }

  /* ---------- state ------------------------------------------------------ */
  const DEFAULTS = { resolution: 'auto', aspect: 'auto', fit: 'letterbox', fps: 'auto', crf: '23',
    preset: 'veryfast', sharpen: false, deinterlace: false, normalize: false };
  const state = { clips: [], merging: false, cancelRequested: false, settings: loadSettings(), resultURL: null };

  function loadSettings() {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('vms-settings') || '{}')); }
    catch (e) { return Object.assign({}, DEFAULTS); }
  }
  function saveSettings() { try { localStorage.setItem('vms-settings', JSON.stringify(state.settings)); } catch (e) { /* ignore */ } }

  /* ---------- theme ------------------------------------------------------ */
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    $('#themeIcon').setAttribute('href', t === 'dark' ? '#i-sun' : '#i-moon');
  }
  (function initTheme() {
    let t = null;
    try { t = localStorage.getItem('vms-theme'); } catch (e) { /* ignore */ }
    if (!t) t = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    applyTheme(t);
    $('#themeBtn').addEventListener('click', () => {
      const n = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(n);
      try { localStorage.setItem('vms-theme', n); } catch (e) { /* ignore */ }
    });
  })();

  /* ---------- engine status --------------------------------------------- */
  function onEngineStatus(s) {
    const pill = $('#enginePill');
    pill.className = 'pill pill--' + s.phase;
    $('#engineText').textContent = s.text;
    if (s.phase === 'ready') probeAll();
    refreshMergeState();
  }

  /* ---------- metadata (thumbnail via <video>) --------------------------- */
  let metaChain = Promise.resolve();
  function browserMeta(file) {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      v.muted = true; v.preload = 'auto'; v.playsInline = true;
      const url = URL.createObjectURL(file);
      const info = {};
      let finished = false;
      const finish = () => {
        if (finished) return; finished = true;
        clearTimeout(timer);
        URL.revokeObjectURL(url); v.removeAttribute('src'); v.load();
        resolve(info);
      };
      const timer = setTimeout(finish, 7000);
      v.onerror = finish;
      v.onloadedmetadata = () => {
        info.duration = v.duration; info.w = v.videoWidth; info.h = v.videoHeight; info.playable = true;
        try { v.currentTime = Math.min(1, (v.duration || 2) / 3); } catch (e) { finish(); }
      };
      v.onseeked = () => {
        try {
          const c = document.createElement('canvas');
          c.width = 264; c.height = Math.max(1, Math.round(264 * (info.h || 9) / (info.w || 16)));
          c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
          info.thumb = c.toDataURL('image/jpeg', 0.72);
        } catch (e) { /* ignore */ }
        finish();
      };
      v.src = url;
    });
  }

  function loadClipMeta(clip) {
    metaChain = metaChain.then(async () => {
      const m = await browserMeta(clip.file);
      if (!state.clips.includes(clip)) return;
      if (m.thumb) clip.thumb = m.thumb;
      if (m.playable) clip.playable = true;
      if (m.duration && isFinite(m.duration) && !clip.info) { clip.duration = m.duration; clip.w = m.w; clip.h = m.h; }
      clip.metaDone = true;
      render();
      if (Engine.isReady()) probeClip(clip);
    });
  }

  async function probeClip(clip) {
    if (clip.info || clip.probing) return;
    clip.probing = true; render();
    try {
      const info = await Engine.probe(clip.file);
      if (state.clips.includes(clip)) { clip.info = info; clip.duration = info.duration || clip.duration; clip.w = info.w || clip.w; clip.h = info.h || clip.h; }
      if (!clip.thumb && info.hasVideo) { render(); clip.thumb = await Engine.thumbnail(clip.file, info.duration); }
    } catch (e) { clip.probeFailed = true; }
    clip.probing = false;
    render();
  }
  function probeAll() { state.clips.forEach((c) => { if (c.metaDone) probeClip(c); }); }

  /* ---------- adding / ordering clips ------------------------------------ */
  function addFiles(fileList) {
    const files = Array.from(fileList || []);
    const ok = files.filter((f) => (f.type && f.type.indexOf('video/') === 0) || VIDEO_EXT.test(f.name));
    const skipped = files.length - ok.length;
    ok.forEach((file) => {
      const clip = { id: uid(), file: file, name: file.name, size: file.size, muted: false,
        thumb: null, duration: 0, w: 0, h: 0, info: null, metaDone: false };
      state.clips.push(clip);
      loadClipMeta(clip);
    });
    if (ok.length) toast(ok.length + (ok.length === 1 ? ' video added' : ' videos added'));
    if (skipped) toast(skipped + ' file(s) skipped — not a video');
    hideError(); render();
  }

  function moveTo(id, newIndex) {
    const from = state.clips.findIndex((c) => c.id === id);
    if (from < 0) return;
    newIndex = Math.max(0, Math.min(state.clips.length - 1, newIndex));
    if (newIndex === from) { render(); return; }
    const [c] = state.clips.splice(from, 1);
    state.clips.splice(newIndex, 0, c);
    render(c.id);
  }
  function removeClip(id) { state.clips = state.clips.filter((c) => c.id !== id); render(); }

  /* ---------- rendering the timeline ------------------------------------- */
  let dragId = null;

  function render(flashId) {
    const list = $('#clipList');
    list.innerHTML = '';
    const n = state.clips.length;
    state.clips.forEach((clip, i) => list.appendChild(clipCard(clip, i, n)));
    $('#emptyState').hidden = n > 0;
    ['#sortBtn', '#reverseBtn', '#clearBtn'].forEach((s) => { $(s).disabled = state.merging || n === 0 || (s !== '#clearBtn' && n < 2); });

    const totalDur = state.clips.reduce((a, c) => a + (c.duration || 0), 0);
    const totalSize = state.clips.reduce((a, c) => a + c.size, 0);
    $('#summary').textContent = n === 0 ? 'No clips yet' :
      n + (n === 1 ? ' clip' : ' clips') + (totalDur ? ' · ' + fmtTime(totalDur) + ' total' : '') + ' · ' + fmtSize(totalSize);
    updatePlan(); refreshMergeState();
    if (flashId) { const el = $('[data-id="' + flashId + '"]'); if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  }

  function clipCard(clip, i, n) {
    const locked = state.merging;
    const numInput = h('input', { class: 'input clip__num', type: 'number', min: '1', max: String(n), value: String(i + 1),
      'aria-label': 'Order number for ' + clip.name, disabled: locked,
      onchange: (e) => moveTo(clip.id, (parseInt(e.target.value, 10) || i + 1) - 1),
      onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); } });

    const thumb = h('button', { class: 'clip__thumb', type: 'button', 'aria-label': 'Preview ' + clip.name,
      disabled: !clip.playable, onclick: () => openPreview(clip) },
      clip.thumb ? h('img', { src: clip.thumb, alt: '' }) : icon('film'),
      clip.playable ? h('span', { class: 'play' }, icon('play')) : null,
      clip.duration ? h('span', { class: 'dur', text: fmtTime(clip.duration) }) : null);

    const meta = h('div', { class: 'clip__meta' },
      extOf(clip.name) ? h('span', { class: 'tag tag--accent', text: extOf(clip.name) }) : null,
      clip.w ? h('span', { class: 'tag', text: clip.w + '×' + clip.h }) : null,
      h('span', { class: 'tag', text: fmtSize(clip.size) }),
      clip.info && clip.info.fps ? h('span', { class: 'tag', text: Math.round(clip.info.fps * 100) / 100 + ' fps' }) : null,
      clip.info && !clip.info.hasAudio ? h('span', { class: 'tag tag--warn', text: 'No audio' }) : null,
      clip.muted ? h('span', { class: 'tag tag--warn', text: 'Muted' }) : null,
      clip.probing ? h('span', { class: 'tag tag--busy', text: 'Analysing…' }) : null,
      clip.probeFailed ? h('span', { class: 'tag tag--warn', text: 'Unreadable?' }) : null);

    const grip = h('div', { class: 'clip__grip', title: 'Drag to reorder', 'aria-hidden': 'true',
      onpointerdown: () => { if (!locked) card.draggable = true; } }, icon('grip'));

    const actions = h('div', { class: 'clip__actions' },
      h('button', { class: 'icon-btn' + (clip.muted ? ' icon-btn--on' : ''), type: 'button', disabled: locked,
        title: clip.muted ? 'Unmute clip' : 'Mute clip', 'aria-label': 'Toggle mute', 'aria-pressed': String(clip.muted),
        onclick: () => { clip.muted = !clip.muted; render(); } }, icon(clip.muted ? 'mute' : 'volume')),
      h('button', { class: 'icon-btn', type: 'button', disabled: locked || i === 0, title: 'Move up', 'aria-label': 'Move up',
        onclick: () => moveTo(clip.id, i - 1) }, icon('up')),
      h('button', { class: 'icon-btn', type: 'button', disabled: locked || i === n - 1, title: 'Move down', 'aria-label': 'Move down',
        onclick: () => moveTo(clip.id, i + 1) }, icon('down')),
      h('button', { class: 'icon-btn icon-btn--danger', type: 'button', disabled: locked, title: 'Remove', 'aria-label': 'Remove',
        onclick: () => removeClip(clip.id) }, icon('trash')));

    const card = h('li', { class: 'clip', 'data-id': clip.id }, grip, numInput, thumb,
      h('div', { class: 'clip__info' }, h('div', { class: 'clip__name', title: clip.name, text: clip.name }), meta), actions);

    card.addEventListener('dragstart', (e) => {
      dragId = clip.id; card.classList.add('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/x-clip', clip.id); } catch (err) { /* ignore */ }
    });
    card.addEventListener('dragend', () => { dragId = null; card.draggable = false; card.classList.remove('is-dragging'); clearDropMarks(); });
    card.addEventListener('dragover', (e) => {
      if (!dragId || dragId === clip.id) return;
      e.preventDefault();
      const r = card.getBoundingClientRect();
      const before = e.clientY < r.top + r.height / 2;
      clearDropMarks(); card.classList.add(before ? 'drop-before' : 'drop-after');
    });
    card.addEventListener('drop', (e) => {
      if (!dragId) return;
      e.preventDefault(); e.stopPropagation();
      const r = card.getBoundingClientRect();
      const before = e.clientY < r.top + r.height / 2;
      const from = state.clips.findIndex((c) => c.id === dragId);
      let to = state.clips.findIndex((c) => c.id === clip.id) + (before ? 0 : 1);
      if (from < to) to--;
      const id = dragId; dragId = null; clearDropMarks();
      moveTo(id, to);
    });
    return card;
  }
  function clearDropMarks() { $$('.drop-before,.drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after')); }

  /* ---------- preview dialog -------------------------------------------- */
  function openPreview(clip) {
    const dlg = $('#previewDialog'), v = $('#previewVideo');
    $('#previewTitle').textContent = clip.name;
    v.src = URL.createObjectURL(clip.file);
    dlg.showModal(); v.play().catch(() => {});
  }
  function closePreview() {
    const dlg = $('#previewDialog'), v = $('#previewVideo');
    v.pause(); if (v.src) URL.revokeObjectURL(v.src); v.removeAttribute('src'); v.load();
    if (dlg.open) dlg.close();
  }
  $('#previewClose').addEventListener('click', closePreview);
  $('#previewDialog').addEventListener('close', closePreview);
  $('#previewDialog').addEventListener('click', (e) => { if (e.target === e.currentTarget) closePreview(); });

  /* ---------- settings panel -------------------------------------------- */
  function bindSettings() {
    ['resolution', 'aspect', 'fps', 'crf', 'preset'].forEach((k) => {
      const el = $('#' + k); el.value = state.settings[k];
      el.addEventListener('change', () => { state.settings[k] = el.value; saveSettings(); updatePlan(); });
    });
    ['sharpen', 'deinterlace', 'normalize'].forEach((k) => {
      const el = $('#' + k); el.checked = !!state.settings[k];
      el.addEventListener('change', () => { state.settings[k] = el.checked; saveSettings(); });
    });
    const seg = $$('#fitSeg button');
    const paint = () => seg.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.fit === state.settings.fit)));
    seg.forEach((b) => b.addEventListener('click', () => { state.settings.fit = b.dataset.fit; saveSettings(); paint(); }));
    paint();
  }

  function updatePlan() {
    const infos = state.clips.map((c) => (c.info ? c.info : (c.w ? { w: c.w, h: c.h, fps: 0 } : null)));
    const P = Engine.plan(infos, state.settings);
    const known = infos.filter(Boolean);
    const best = known.sort((a, b) => b.w * b.h - a.w * a.h)[0];
    $('#planMain').textContent = 'Output: ' + P.W + ' × ' + P.H + ' · ' + P.fps + ' fps · MP4 (H.264 + AAC)';
    let hint = 'Clips with a different shape are fitted automatically.';
    if (best && P.W * P.H > best.w * best.h * 1.05) hint = 'Upscaling your largest clip (' + best.w + '×' + best.h + ') with Lanczos' + (state.settings.sharpen ? ' + sharpening.' : '. Turn on “Enhance sharpness” for a crisper look.');
    else if (P.H >= 2160 || P.W >= 2160) hint = '4K is very slow to encode in a browser. Expect a long wait.';
    else if (best && P.W * P.H < best.w * best.h * 0.95) hint = 'Output is smaller than your largest clip (' + best.w + '×' + best.h + ').';
    $('#planHint').textContent = hint;
  }

  /* ---------- merging ---------------------------------------------------- */
  function refreshMergeState() {
    const n = state.clips.length;
    const btn = $('#mergeBtn'), hint = $('#mergeHint');
    btn.disabled = state.merging || n < 2 || !Engine.isReady();
    $('#mergeLabel').textContent = n >= 2 ? 'Merge ' + n + ' videos' : 'Merge videos';
    hint.hidden = state.merging;
    hint.textContent = n < 2 ? 'Add at least 2 clips to start.' : !Engine.isReady() ? 'Waiting for the engine to start…' : 'Clips play in the order shown in the timeline.';
  }

  function showError(msg) {
    $('#errorMsg').textContent = msg;
    $('#errorLog').textContent = Engine.getLog(40) || '(no log)';
    $('#errorBox').hidden = false;
  }
  function hideError() { $('#errorBox').hidden = true; }

  let timer = null, t0 = 0;
  function setMerging(on) {
    state.merging = on;
    $('#progressBox').hidden = !on;
    $('#mergeBtn').hidden = on;
    $('#mergeHint').hidden = on;
    if (on) {
      t0 = performance.now(); updateProgress({ overall: 0, text: 'Starting…' });
      timer = setInterval(() => { $('#elapsed').textContent = 'Elapsed ' + fmtTime((performance.now() - t0) / 1000); }, 500);
    } else { clearInterval(timer); }
    render();
  }
  function updateProgress(p) {
    const pct = Math.round((p.overall || 0) * 100);
    $('#progressText').textContent = p.text;
    $('#progressPct').textContent = pct + '%';
    $('#barFill').style.width = pct + '%';
    $('.bar').setAttribute('aria-valuenow', String(pct));
    const el = (performance.now() - t0) / 1000;
    $('#eta').textContent = p.overall > 0.04 && p.overall < 0.97 ? '≈ ' + fmtTime(el / p.overall - el) + ' left' : '';
  }

  async function onMerge() {
    if (state.merging || state.clips.length < 2) return;
    hideError(); $('#resultPanel').hidden = true;
    state.cancelRequested = false;
    setMerging(true);
    const items = state.clips.map((c) => ({ file: c.file, name: c.name, muted: c.muted, info: c.info }));
    try {
      const out = await Engine.merge(items, state.settings, updateProgress);
      items.forEach((it, i) => { if (!state.clips[i].info && it.info) state.clips[i].info = it.info; });
      showResult(out, (performance.now() - t0) / 1000);
    } catch (e) {
      if (state.cancelRequested || e.cancelled) toast('Merge cancelled');
      else { console.error(e); showError(e.message || String(e)); }
    } finally {
      setMerging(false);
    }
  }

  async function onCancel() {
    state.cancelRequested = true;
    $('#cancelBtn').disabled = true; $('#progressText').textContent = 'Cancelling…';
    await Engine.cancel();
    $('#cancelBtn').disabled = false;
  }

  function showResult(out, seconds) {
    if (state.resultURL) URL.revokeObjectURL(state.resultURL);
    state.resultURL = URL.createObjectURL(out.blob);
    const v = $('#resultVideo'); v.src = state.resultURL;
    $('#resultStats').innerHTML = '';
    [['Resolution', out.width + ' × ' + out.height], ['Frame rate', out.fps + ' fps'], ['Length', fmtTime(out.duration)],
      ['File size', fmtSize(out.blob.size)], ['Took', fmtTime(seconds)]].forEach((r) => {
      $('#resultStats').appendChild(h('dt', { text: r[0] })); $('#resultStats').appendChild(h('dd', { text: r[1] }));
    });
    updateDownloadName();
    $('#resultPanel').hidden = false;
    $('#resultPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    toast('Merge complete');
  }
  function updateDownloadName() {
    let n = ($('#fileName').value || 'merged-video').replace(/[\\/:*?"<>|]+/g, '').trim() || 'merged-video';
    n = n.replace(/\.mp4$/i, '');
    const a = $('#downloadBtn'); a.href = state.resultURL || '#'; a.download = n + '.mp4';
  }

  /* ---------- wiring ----------------------------------------------------- */
  const picker = $('#filePicker'), dz = $('#dropzone');
  picker.addEventListener('change', () => { addFiles(picker.files); picker.value = ''; });
  dz.addEventListener('click', (e) => { if (!e.target.closest('label')) picker.click(); });
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); picker.click(); } });

  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') !== -1;
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; dragDepth++; $('#dropOverlay').hidden = false; dz.classList.add('is-over'); });
  window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').hidden = true; dz.classList.remove('is-over'); } });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; $('#dropOverlay').hidden = true; dz.classList.remove('is-over');
    addFiles(e.dataTransfer.files);
  });

  $('#clipList').addEventListener('dragover', (e) => { if (dragId) e.preventDefault(); });
  $('#sortBtn').addEventListener('click', () => {
    state.clips.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })); render(); toast('Sorted by name');
  });
  $('#reverseBtn').addEventListener('click', () => { state.clips.reverse(); render(); });
  $('#clearBtn').addEventListener('click', () => {
    if (!state.clips.length) return;
    if (confirm('Remove all ' + state.clips.length + ' clips from the timeline?')) { state.clips = []; hideError(); render(); }
  });
  $('#mergeBtn').addEventListener('click', onMerge);
  $('#cancelBtn').addEventListener('click', onCancel);
  $('#fileName').addEventListener('input', updateDownloadName);
  $('#resultClose').addEventListener('click', () => { $('#resultPanel').hidden = true; });
  window.addEventListener('beforeunload', (e) => { if (state.clips.length) { e.preventDefault(); e.returnValue = ''; } });

  bindSettings();
  render();
  Engine.init(onEngineStatus).catch(() => {});
})();
