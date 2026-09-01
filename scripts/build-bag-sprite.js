#!/usr/bin/env node
/**
 * Rebuild assets/anim/bag-fill.webp from the source sprite sheet.
 *
 *   python3 scripts/build-bag-sprite.py <source.png>
 *
 * This file is the RECORD of how the shipped sheet was made; the work itself is
 * in the .py next to it, because Pillow is what is installed on this box.
 *
 * The source (6y9HsPBq.png, 2560x4096, 5 cols x 8 rows of 512px frames) is NOT
 * in fill order. It sits empty for seven frames, blips full at 7 and 17, drops
 * back to empty at 19, then plateaus twice. Played 0 -> 39 the bag fills,
 * empties and refills. So the shipped sheet is a curated subsequence of the
 * distinct stages, in the order they read:
 *
 *   empty -> milk -> +orange -> +oranges -> +baguette -> settle -> +greens -> full
 *
 * PICKS below is that subsequence. Frames 19 and 20 are deliberately absent:
 * 19 loses the oranges and 20 loses them again, and a bag that un-fills mid-run
 * is the one thing this animation must never do.
 */
