# 作画 sakugify

A small, Sakugabooru-style animation gallery where every post opens in a player built for studying animation:

- **Frame by frame:** `,` `.` or `←` `→` step one frame.
- **Drawing by drawing:** `[` `]` or `Shift`+arrows jump to the next or previous *drawing* (frames that change), skipping holds.
- **Timing sheet:** a colored strip under the video shows every drawing at its real length: **on 1s**, **on 2s**, **on 3s** or **held**. Drag across it to scrub.
- **Drawing strip:** a thumbnail for every drawing. Click one to jump to it.
- **Every frame:** switch the strip to lay out the whole clip in rows like a timing sheet. Frames that start a new drawing are highlighted and numbered, and repeated frames are dimmed with `=`. The highlighted frames are the ones the motion needs; drop the repeats and it plays the same.
- **Slow playback:** 0.1×, 0.25×, 0.5× and 1× (`1`–`4`), plus loop and sound toggles.
- **Booru gallery:** tags colored by type (artist / copyright / meta / general), tag search with `-exclusion`, voting, and a tag list.

## How drawings are found

Every frame is compared with the one before it, after cancelling brightness flicker and small camera pans (±3 px block matching on a 96×72 copy). A frame that changes starts a new drawing; a frame that doesn't is the same drawing held. The threshold adapts per clip when the differences split clearly into "held" and "new". Otherwise a fixed noise level is used. Uploads are analyzed in the browser. The starter clips are precomputed with the same algorithm.

## Starter collection

Eight-second excerpts of openly licensed animation from the Internet Archive.

**Anime-style action: Morevna Project (CC BY-SA).** *Morevna* is an open-source anime series, and *Pepper & Carrot* is the Morevna Project's adaptation of David Revoy's webcomic. These excerpts are shared under the same licenses as their sources: CC BY-SA 3.0 for Morevna Episode 3 and Pepper & Carrot Episode 6, and CC BY-SA 4.0 for Morevna Episode 4 and Pepper & Carrot Episode 3. Credit: Morevna Project; Pepper & Carrot is based on the webcomic by David Revoy.

| Clip | Year | Source | License |
|---|---|---|---|
| Morevna: Episode 4 (robot attack, car chase) | 2019 | archive.org/details/morevna-ep4 | CC BY-SA 4.0 |
| Morevna: Episode 3 (standoff, Marya, mecha) | 2016 | archive.org/details/morevna-ep3 | CC BY-SA 3.0 |
| Pepper & Carrot: The Potion Contest | 2017 | archive.org/details/peppercarrot-ep6 | CC BY-SA 3.0 |
| Pepper & Carrot: The Secret Ingredients | 2022 | archive.org/details/pepper-carrot-episode-3-the-secret-ingredients-english | CC BY-SA 4.0 |

**Classic cartoons (public domain).** Telecined TV transfers were converted back to 23.976 fps film frames so stepping lands on real drawings.

| Clip | Year | Source |
|---|---|---|
| Superman: The Mad Scientist | 1941 | archive.org/details/superman_1941 |
| Superman: The Mechanical Monsters | 1941 | archive.org/details/mechanical_monsters_1941 |
| Popeye the Sailor Meets Sindbad the Sailor | 1936 | archive.org/details/Popeye_meetsSinbadtheSailor |
| Betty Boop: Snow White | 1933 | archive.org/details/bb_snow_white |
| Betty Boop: Minnie the Moocher | 1932 | archive.org/details/bb_minnie_the_moocher |
| Betty Boop: Bimbo's Initiation | 1931 | archive.org/details/BimbosInitiation_201802 |
| The Skeleton Dance | 1929 | archive.org/details/the-skeleton-dance-1929 |
| Steamboat Willie | 1928 | archive.org/details/steamboat-willie_1928 |
| Felix the Cat: Feline Follies | 1919 | archive.org/details/FelixTheCat-FelineFollies1919 |
| Gertie the Dinosaur | 1914 | archive.org/details/GertieTheDinosaur |

## Run it

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

Your own uploads are stored in the browser (IndexedDB) and never leave your device.

## Files

- `index.html`, `style.css`, `app.js`: the whole app (gallery, player, analysis, upload)
- `clips/`: starter clips (`.webm`), posters (`.jpg`) and `seed.json` (metadata, frame counts, drawing start frames)
