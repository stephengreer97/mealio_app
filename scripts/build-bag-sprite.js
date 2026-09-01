#!/usr/bin/env node
/**
 * Rebuild assets/anim/bag-fill.webp from the source sprite sheet.
 *
 *   python3 scripts/build-bag-sprite.py <source.png>
 *
 * This file is the RECORD of how the shipped sheet was made; the work itself is
 * in the .py next to it, because Pillow is what is installed on this box.
 *
 * The source (6y9HsPBq.png, 2560x4096, 5 cols x 8 rows of 512px frames) ships
 * WHOLE and IN ORDER: PICKS is 0..39.
 *
 * Earlier builds curated a subsequence, because the raw order is not a monotonic
 * fill — it sits empty for seven frames, shows milk at 7, goes empty again until
 * 17, dips at 19, then runs baguette (20-29) and greens (30-39). Stephen's call,
 * 2026-09-01: use every frame, in sheet order, and do not reorder them. It is
 * his artwork; playback follows it.
 */
