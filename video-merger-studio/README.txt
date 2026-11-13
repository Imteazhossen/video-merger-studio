VIDEO MERGER STUDIO
===================

HOW TO USE
1. Keep this whole folder together (index.html + css + js + engine).
2. Double-click index.html (best in Google Chrome, Microsoft Edge or Brave).
3. Wait for the green "Engine ready" badge (a few seconds the first time).
4. Add videos (Browse files, or drag & drop them anywhere on the page).
5. Set the order: drag the ⠿ handle, use the ▲ ▼ buttons, or type a number in the order box.
6. Choose output settings (resolution, fit mode, quality) and press "Merge".
7. Preview the result and press "Download MP4".

FOLDER
  index.html        page structure
  css/style.css     all styling (design tokens, light + dark theme)
  js/app.js         user interface logic
  js/engine.js      video engine wrapper (ffmpeg.wasm)
  engine/           the offline video engine (no internet needed)

NOTES
- Everything runs inside your browser. Videos are never uploaded.
- Browser encoding is slower than desktop software. Higher resolutions, "Blur fill",
  and slower speed presets take longer. 4K is very slow.
- Very large inputs (more than ~1.5 GB of combined output) can hit browser memory limits.
- Clips with different sizes/frame rates are converted to one common format automatically;
  clips without audio get silence so the sound stays in sync.
