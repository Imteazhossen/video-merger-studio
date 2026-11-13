/* ==========================================================================
   Video Merger Studio — engine.js
   Wraps ffmpeg.wasm. Works from a double-click (file://) because the engine
   is loaded from the local /engine folder via <script> tags, not fetch().
   Public API: window.Engine = { init, probe, plan, merge, cancel, getLog }
   ========================================================================== */
(function () {
  'use strict';

  const S = {
    ff: null, ready: false, wasm: null, workerURL: null,
    logs: [], cancelled: false, onTime: null, chain: Promise.resolve(), uid: 0,
    initPromise: null, statusCb: function () {}
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const even = (n) => Math.max(2, 2 * Math.round(n / 2));
  const safeExt = (name) => {
    const m = /\.([a-z0-9]{1,5})$/i.exec(name || '');
    return m ? m[1].toLowerCase() : 'bin';
  };

  /* ---------- engine start-up ------------------------------------------- */
  async function waitForFiles(timeoutMs) {
    const t0 = Date.now();
    for (;;) {
      const E = window.__E;
      if (window.FFmpegWASM && E && E.worker && E.core && E.wasm) return;
      if (Date.now() - t0 > timeoutMs) {
        throw new Error('Engine files were not found. Keep the whole folder together (index.html + css + js + engine).');
      }
      await sleep(100);
    }
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function installWorkerPatch() {
    if (window.__workerPatched) return;
    const OriginalWorker = window.Worker;
    function PatchedWorker(url, opts) {
      const isFF = String(url).indexOf('814.ffmpeg.js') !== -1;
      const w = new OriginalWorker(isFF ? S.workerURL : url, opts);
      if (isFF) {
        const copy = S.wasm.slice();           // each worker gets its own copy
        w.postMessage({ __wasm: copy.buffer }, [copy.buffer]);
      }
      return w;
    }
    PatchedWorker.prototype = OriginalWorker.prototype;
    window.Worker = PatchedWorker;
    window.__workerPatched = true;
  }

  async function createInstance() {
    const ff = new window.FFmpegWASM.FFmpeg();
    ff.on('log', ({ message }) => {
      S.logs.push(message);
      if (S.logs.length > 600) S.logs.splice(0, 200);
    });
    ff.on('progress', ({ progress, time }) => {
      if (S.onTime) S.onTime(progress, time);
    });
    await ff.load({ coreURL: 'data:text/javascript,', wasmURL: 'data:application/wasm,' });
    S.ff = ff;
    S.ready = true;
  }

  function init(statusCb) {
    if (statusCb) S.statusCb = statusCb;
    if (S.initPromise) return S.initPromise;
    S.initPromise = (async () => {
      try {
        S.statusCb({ phase: 'loading', text: 'Loading engine…' });
        await waitForFiles(60000);
        const E = window.__E;
        S.wasm = b64ToBytes(E.wasm);
        E.wasm = null;                                   // free the big string
        const snippet =
          "self.addEventListener('message',function(e){if(e.data&&e.data.__wasm){" +
          "self.__WASM=new Uint8Array(e.data.__wasm);e.stopImmediatePropagation();}});\n";
        const key = 'self.createFFmpegCore({mainScriptUrlOrBlob';
        if (E.worker.indexOf(key) === -1) throw new Error('Unsupported engine version.');
        const patched = E.worker.replace(key, 'self.createFFmpegCore({wasmBinary:self.__WASM,mainScriptUrlOrBlob');
        S.workerURL = URL.createObjectURL(new Blob([E.core, ';\n', snippet, patched], { type: 'text/javascript' }));
        installWorkerPatch();
        S.statusCb({ phase: 'loading', text: 'Starting engine…' });
        await createInstance();
        S.statusCb({ phase: 'ready', text: 'Engine ready' });
      } catch (e) {
        console.error(e);
        S.initPromise = null;
        S.statusCb({ phase: 'error', text: 'Engine failed: ' + (e.message || e) });
        throw e;
      }
    })();
    return S.initPromise;
  }

  /* ---------- serialise access to ffmpeg -------------------------------- */
  function locked(fn) {
    const p = S.chain.then(() => fn());
    S.chain = p.catch(() => {});
    return p;
  }

  /* ---------- probing --------------------------------------------------- */
  function parseProbe(txt) {
    const info = { duration: 0, w: 0, h: 0, fps: 0, hasAudio: false, hasVideo: false };
    let m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(txt);
    if (m) info.duration = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
    const vline = txt.split('\n').find((l) => /Stream #\d+:\d+.*Video:/.test(l) && !/attached pic/.test(l));
    if (vline) {
      info.hasVideo = true;
      const clean = vline.replace(/\([^)]*\)/g, '');
      m = /\b(\d{2,5})x(\d{2,5})\b/.exec(clean);
      if (m) { info.w = +m[1]; info.h = +m[2]; }
      m = /(\d+(?:\.\d+)?)\s*fps/.exec(clean);
      if (m) info.fps = parseFloat(m[1]);
    }
    m = /rotation of (-?\d+(?:\.\d+)?) degrees/.exec(txt) || /rotate\s*:\s*(-?\d+)/.exec(txt);
    if (m && Math.abs(Math.round(+m[1])) % 180 === 90) { const t = info.w; info.w = info.h; info.h = t; }
    info.hasAudio = /Stream #\d+:\d+.*Audio:/.test(txt);
    return info;
  }

  async function mountFile(file, dir) {
    const f = new File([file], 'in.' + safeExt(file.name), { type: file.type });
    await S.ff.createDir(dir);
    await S.ff.mount('WORKERFS', { files: [f] }, dir);
    return dir + '/' + f.name;
  }
  async function unmountFile(dir) {
    try { await S.ff.unmount(dir); } catch (e) { /* ignore */ }
    try { await S.ff.deleteDir(dir); } catch (e) { /* ignore */ }
  }

  function probe(file) {
    return locked(async () => {
      if (!S.ready) throw new Error('Engine not ready');
      const dir = '/p' + (++S.uid);
      try {
        const path = await mountFile(file, dir);
        S.logs.length = 0;
        await S.ff.exec(['-hide_banner', '-i', path]);
        return parseProbe(S.logs.join('\n'));
      } finally {
        await unmountFile(dir);
      }
    });
  }

  /* ---------- output planning ------------------------------------------- */
  function plan(infos, s) {
    const known = infos.filter((i) => i && i.w && i.h).sort((a, b) => b.w * b.h - a.w * a.h);
    const big = known[0] || { w: 1920, h: 1080 };
    let ar = big.w / big.h;
    if (s.aspect !== 'auto') { const p = s.aspect.split(':').map(Number); ar = p[0] / p[1]; }
    else {
      // snap to the nearest standard shape when it is within 4% (e.g. 480x854 -> 9:16)
      const std = [16 / 9, 9 / 16, 4 / 3, 3 / 4, 1, 21 / 9, 3 / 2, 2 / 3];
      let best = ar, err = 0.04;
      std.forEach((c) => { const e = Math.abs(c - ar) / c; if (e < err) { err = e; best = c; } });
      ar = best;
    }
    const short = s.resolution === 'auto' ? Math.min(big.w, big.h) : parseInt(s.resolution, 10);
    let W, H;
    if (ar >= 1) { H = short; W = short * ar; } else { W = short; H = short / ar; }
    let fps;
    if (s.fps === 'auto') {
      const maxFps = Math.max.apply(null, [0].concat(known.map((i) => i.fps || 0)));
      fps = Math.min(60, Math.max(24, Math.round(maxFps || 30)));
    } else fps = parseInt(s.fps, 10);
    return { W: even(W), H: even(H), fps: fps };
  }

  /* ---------- filter graph ---------------------------------------------- */
  function videoGraph(p, s) {
    const di = s.deinterlace ? 'yadif=0:-1:1,' : '';
    const post = ['setsar=1', s.sharpen ? 'unsharp=5:5:0.9:5:5:0.0' : null, 'fps=' + p.fps, 'format=yuv420p']
      .filter(Boolean).join(',');
    const W = p.W, H = p.H;
    if (s.fit === 'crop') {
      return `[0:v]${di}scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},${post}[v]`;
    }
    if (s.fit === 'blur') {
      const sw = even(W / 8), sh = even(H / 8);
      return `[0:v]${di}split=2[a][b];` +
        `[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},scale=${sw}:${sh},boxblur=4:2,scale=${W}:${H}[bg];` +
        `[b]scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos[fg];` +
        `[bg][fg]overlay=(W-w)/2:(H-h)/2,${post}[v]`;
    }
    return `[0:v]${di}scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,${post}[v]`;
  }

  /* ---------- merge ------------------------------------------------------ */
  function cancelledError() { const e = new Error('Cancelled'); e.cancelled = true; return e; }
  function tailLog(n) { return S.logs.slice(-n).join('\n'); }

  async function merge(items, s, cb) {
    if (!S.ready) throw new Error('Engine not ready yet');
    S.cancelled = false;
    const total = items.length;
    const created = [];
    const report = (o) => { try { cb(o); } catch (e) { /* ignore */ } };

    return locked(async () => {
      try {
        /* 1) analyse */
        for (let i = 0; i < total; i++) {
          if (S.cancelled) throw cancelledError();
          report({ stage: 'analyze', index: i, total, overall: 0, text: `Analysing clip ${i + 1} of ${total}…` });
          if (!items[i].info) {
            const dir = '/a' + (++S.uid);
            try {
              const path = await mountFile(items[i].file, dir);
              S.logs.length = 0;
              await S.ff.exec(['-hide_banner', '-i', path]);
              items[i].info = parseProbe(S.logs.join('\n'));
            } finally { await unmountFile(dir); }
          }
          if (!items[i].info.hasVideo) throw new Error(`"${items[i].name}" has no video stream or is not readable.`);
        }
        const P = plan(items.map((x) => x.info), s);
        const vg = videoGraph(P, s);
        const durs = items.map((x) => (x.info.duration > 0 ? x.info.duration : 1));
        const sumDur = durs.reduce((a, b) => a + b, 0);
        let doneDur = 0;

        /* 2) normalise every clip to the same format */
        for (let i = 0; i < total; i++) {
          if (S.cancelled) throw cancelledError();
          const it = items[i];
          const dir = '/m' + (++S.uid);
          const out = `part${i}.mp4`;
          const useAudio = it.info.hasAudio && !it.muted;
          const dur = durs[i];
          const knownDur = it.info.duration > 0;
          S.onTime = (progress, time) => {
            let frac = time > 0 ? time / 1e6 / dur : progress;
            frac = Math.max(0, Math.min(1, isFinite(frac) ? frac : 0));
            const overall = Math.min(0.97, ((doneDur + frac * dur) / sumDur) * 0.97);
            report({ stage: 'encode', index: i, total, clipPct: frac, overall,
              text: `Converting clip ${i + 1} of ${total} — ${Math.round(frac * 100)}%` });
          };
          report({ stage: 'encode', index: i, total, clipPct: 0, overall: (doneDur / sumDur) * 0.97,
            text: `Converting clip ${i + 1} of ${total} — 0%` });
          try {
            const path = await mountFile(it.file, dir);
            let graph = vg;
            const args = ['-hide_banner', '-i', path];
            if (useAudio) {
              graph += `;[0:a:0]${s.normalize ? 'loudnorm=I=-16:TP=-1.5:LRA=11,' : ''}` +
                'aresample=48000:async=1:first_pts=0,aformat=channel_layouts=stereo' + (knownDur ? ',apad' : '') + '[a]';
              args.push('-filter_complex', graph, '-map', '[v]', '-map', '[a]');
            } else {
              args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
                '-filter_complex', graph, '-map', '[v]', '-map', '1:a');
            }
            args.push('-c:v', 'libx264', '-preset', s.preset, '-crf', String(s.crf), '-profile:v', 'high',
              '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
              '-video_track_timescale', '90000');
            // NOTE: never combine apad with -shortest (it never terminates); limit by duration instead.
            if (knownDur) args.push('-t', dur.toFixed(3)); else args.push('-shortest');
            args.push('-y', out);
            const code = await S.ff.exec(args);
            if (S.cancelled) throw cancelledError();
            if (code !== 0) throw new Error(`Could not convert "${it.name}". The file may be damaged or use an unsupported format.`);
            created.push(out);
          } finally {
            await unmountFile(dir);
          }
          doneDur += dur;
        }
        S.onTime = null;

        /* 3) join */
        if (S.cancelled) throw cancelledError();
        report({ stage: 'join', index: total, total, overall: 0.97, text: 'Joining clips…' });
        let outName = 'part0.mp4';
        if (total > 1) {
          const list = created.map((n) => `file '${n}'`).join('\n') + '\n';
          await S.ff.writeFile('list.txt', list);
          created.push('list.txt');
          const code = await S.ff.exec(['-hide_banner', '-f', 'concat', '-safe', '0', '-i', 'list.txt',
            '-c', 'copy', '-movflags', '+faststart', '-y', 'merged.mp4']);
          if (code !== 0) throw new Error('Joining the clips failed.');
          created.push('merged.mp4');
          outName = 'merged.mp4';
        }
        const data = await S.ff.readFile(outName);
        const blob = new Blob([data.buffer], { type: 'video/mp4' });
        report({ stage: 'done', index: total, total, overall: 1, text: 'Done' });
        return { blob: blob, width: P.W, height: P.H, fps: P.fps, duration: sumDur };
      } finally {
        S.onTime = null;
        if (!S.cancelled) {
          for (const n of created) { try { await S.ff.deleteFile(n); } catch (e) { /* ignore */ } }
        }
      }
    });
  }

  /* Grab one frame as a JPEG data-URL (used for formats the browser cannot decode, e.g. VOB/DAT). */
  function thumbnail(file, duration) {
    return locked(async () => {
      if (!S.ready) return null;
      const dir = '/t' + (++S.uid);
      const out = 'thumb' + S.uid + '.jpg';
      try {
        const path = await mountFile(file, dir);
        const at = Math.max(0, Math.min(1, (duration || 2) / 3));
        const code = await S.ff.exec(['-hide_banner', '-ss', at.toFixed(2), '-i', path, '-frames:v', '1',
          '-vf', 'scale=264:-2', '-q:v', '5', '-y', out]);
        if (code !== 0) return null;
        const data = await S.ff.readFile(out);
        let bin = '';
        for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000));
        return 'data:image/jpeg;base64,' + btoa(bin);
      } catch (e) {
        return null;
      } finally {
        try { await S.ff.deleteFile(out); } catch (e) { /* ignore */ }
        await unmountFile(dir);
      }
    });
  }

  async function cancel() {
    S.cancelled = true;
    try { S.ff.terminate(); } catch (e) { /* ignore */ }
    S.ready = false;
    S.ff = null;
    S.chain = Promise.resolve();
    S.statusCb({ phase: 'loading', text: 'Restarting engine…' });
    try {
      await createInstance();
      S.statusCb({ phase: 'ready', text: 'Engine ready' });
    } catch (e) {
      S.statusCb({ phase: 'error', text: 'Engine failed: ' + (e.message || e) });
    }
  }

  window.Engine = { init: init, probe: probe, thumbnail: thumbnail, plan: plan, merge: merge, cancel: cancel,
    getLog: function (n) { return tailLog(n || 40); }, isReady: function () { return S.ready; } };
})();
