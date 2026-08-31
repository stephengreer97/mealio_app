# Flow maps

How each part of Mealio actually decides what it does, read off the code rather
than off the design. 19 pages, 46 diagrams.

Open `index.html` — either directly in a browser, or through the little server:

```bash
node docs/flow-maps/serve.js      # http://localhost:8777/
```

On Windows, `serve.cmd` does the same and opens a browser (there is a Desktop
shortcut pointing at it). Everything renders locally; nothing on these pages
calls out to the network — `assets/mermaid.min.js` is vendored for exactly that
reason.

## Keeping them true

`sources.json` records, per map, which source files it was read from and the
commit it was read at.

```bash
npm run flow-maps          # which maps describe source that has since moved
npm run flow-maps:bless    # record that they have been re-read, at HEAD
```

A `PreToolUse` hook (`.claude/hooks/flow-map-check.sh`) runs the first of those
before any `git push` and blocks if a map's sources have changed, so a map and
the code it describes travel in the same push. It reports; it does not judge — a
rename or a new test does not invalidate a map, and the verdict is the reader's.
Bless anyway in that case: the record is that someone **looked**.

To push past it deliberately, prefix the command with
`MEALIO_SKIP_FLOWMAP_CHECK=1`.

## Adding a map

1. Write `<name>.html` — copy the head/topbar/legend from any existing page; the
   shared CSS and the mermaid init live in `assets/`.
2. Add a tile to `index.html`.
3. Add an entry to `sources.json` naming the files you read.
4. `npm run flow-maps` — it should say the new map is current.

Keep diagrams free of raw regexes and other bracket-heavy literals: mermaid
parses `[` and `]` as node syntax and a stray one breaks the whole diagram.
Describe the pattern in words in the node and put the literal in the notes below
it, where it is plain HTML.
