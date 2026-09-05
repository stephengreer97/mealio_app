// A BACKTICK IN A COMMENT INSIDE AN INJECTED SCRIPT. Five times now.
//
// This file imports NOTHING from src, and that is its entire design.
//
// The first attempt lived in injectedScriptSafety.test.ts, which reads the
// BUILT scripts and therefore has to import them. A backtick inside a template
// literal ends the literal early and the module stops compiling -- so that
// suite reported "failed to run" and the check never executed. The test that
// exists to catch the bug was disabled BY the bug, which is the same shape as
// the bug itself and took a mutation run to notice.
//
// Reading the files as TEXT needs no import, so it still runs when nothing
// compiles. `tsc --noEmit` catches this too and is the real gate; this exists
// to say WHICH LINE, because the compiler points hundreds of characters away
// at whatever the truncated literal ran into.
import * as fs from 'fs';
import * as path from 'path';

// ── The one this file could NOT catch, read from source instead ─────────────
//
// Everything above reads the BUILT scripts, which is the right place to see a
// backslash that got eaten. It is the wrong place for a backtick, and today was
// the fifth time: a backtick inside a comment ends the template literal early,
// so the module stops compiling and this suite cannot import it. The test that
// exists to catch the bug is disabled BY the bug.
//
// Reading the source as text needs no import, so it survives a file that does
// not compile. And the failure mode is narrow enough to detect exactly: every
// occurrence has been a backtick inside a `//` comment, used as prose quoting
// around an identifier.
describe('no backtick in a comment inside an injected script', () => {
  const DIR = path.resolve(__dirname, '../../src/lib/webview-scripts');

  /** Files whose whole job is emitting script text. */
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.ts'));

  it('has files to scan', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files)('%s', (file) => {
    const src = fs.readFileSync(path.join(DIR, file), 'utf8');
    const offenders: string[] = [];
    let inTemplate = false;
    src.split('\n').forEach((line, i) => {
      // Track template-literal depth crudely by counting unescaped backticks on
      // lines that are NOT comments. Crude is enough: what matters is whether a
      // COMMENT line carries one, and a comment cannot open a literal.
      const comment = line.trimStart().startsWith('//');
      if (!comment) {
        const ticks = (line.match(/(?<!\\)`/g) ?? []).length;
        if (ticks % 2 === 1) inTemplate = !inTemplate;
        return;
      }
      if (inTemplate && line.includes('`')) {
        offenders.push(`${file}:${i + 1}  ${line.trim().slice(0, 70)}`);
      }
    });
    expect(offenders).toEqual([]);
  });
});
