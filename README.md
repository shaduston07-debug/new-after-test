# 作画 sakugify

A booru-style gallery where **every clip you upload is re-animated as sakuga**. Drop in any video, and it comes out with anime frame timing, cel shading, smears, impact frames and dramatic framing. Each result is posted to a local, tag-searchable gallery.

Everything runs in the browser on the GPU (WebGL). No server, no uploads: clips never leave your device.

## Run it

Any static file server works:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

Or host the folder on GitHub Pages, Netlify, etc. It's three files plus `index.html`.

## What it does to a clip

| Effect | How |
|---|---|
| **Timing on 1s / 2s / 3s** | Drawings are made on a 24fps grid and held. *Auto* follows the motion: fast action on ones, acting on twos, still moments on threes. |
| **Cel shading + line art** | Light is cut into flat bands with tinted shadows and highlights, then inked with Sobel edges. |
| **Smears & multiples** | Moving regions (a low-res motion mask) are stretched along their motion vector (block matching) and onion-skinned with the previous drawing. |
| **Impact frames** | Motion spikes trigger alternating two-tone frames, radial speed lines, camera shake and a zoom punch. |
| **Styles** | TV anime · 90s cel (warm grade, grain, vignette) · Genga (pencil key drawing with red/blue shadow lines) · Manga ink (screentone) |
| **Framing** | 1.85 / 2.39 letterbox, film grain; the camera moves on the same timing as the drawings. |

Posts get auto-tags (`smears`, `impact_frames`, `fighting`, `full_animation`, `character_acting`, `background_animation`, …) plus artist/copyright tags. Search supports `-tag` exclusion.

## Notes

- Rendering is real-time (MediaRecorder), so keep the tab visible while it records.
- Output is WebM (Chrome/Firefox/Edge) or MP4 (Safari).
- The gallery lives in IndexedDB, so it's per browser.

## Files

- `engine.js`: `SakugaEngine` (motion analysis, timing, the two WebGL passes)
- `app.js`: routing, gallery/post/tag pages, upload, render and record
- `style.css`, `index.html`
