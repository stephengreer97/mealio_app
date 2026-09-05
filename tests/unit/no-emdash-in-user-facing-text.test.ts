// NO EM DASH IN TEXT A USER READS.
//
// Stephen, 2026-09-05: "remember to never put an emdash into user facing text
// ever again." A one-time clean decays, so this is the part that lasts.
//
// WHY AN AST AND NOT A GREP. A grep for U+2014 across src/ returns ~1700 hits
// and almost all of them are COMMENTS, which the rule deliberately does not
// touch: half of what this repo knows is written down in prose above the code,
// and rewriting that for punctuation would be churn with a real chance of
// breaking an injected script. The TypeScript parser knows the difference
// between a comment and a string, so it is the thing that should decide.
//
// WHAT COUNTS AS USER-FACING. Everything in a string, EXCEPT the exclusions
// below. That direction matters. A rule that lists what to check has to be
// extended for every new screen and silently misses the ones nobody remembered;
// a rule that lists what to SKIP fails loudly on anything new, which is the
// error worth having. Each exclusion is named and justified rather than being a
// path glob someone can widen without noticing.
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const EM_DASH = '—';
const SRC = path.resolve(__dirname, '../../src');

/**
 * Files whose strings are code or developer prose, never rendered copy.
 *
 * webview-scripts and the two shims emit JAVASCRIPT as text, comments and all.
 * An em dash inside one of those is a comment in the injected program; it
 * reaches a store's page, never a user's eye.
 *
 * fixture-capture-config is the operator's script for the capture tool, read by
 * whoever is driving a browser to record a fixture.
 *
 * The two merge.ts files are config-validation warnings. They land in logs and
 * the admin config view as diagnostics about a malformed remote config.
 */
const EXCLUDED_FILES = (rel: string) =>
  rel.startsWith('lib/webview-scripts/')
  || rel === 'lib/webview-fingerprint-shim.ts'
  || rel === 'lib/webview-user-agent.ts'
  || rel === 'lib/webview-user-agent-build.ts'
  || rel === 'lib/fixture-capture-config.ts'
  || rel === 'lib/automation-config/merge.ts'
  || rel === 'lib/store-catalog/merge.ts'
  || rel === 'components/FingerprintProbe.tsx';

/**
 * Call targets whose arguments are never rendered.
 *
 * console.* and logger.* are obvious. `warnings.push` is the collector the
 * config validators write diagnostics into. `netPrewarmSettle` takes a `why`
 * whose only sink is a console.log, which the AST cannot see from the call
 * site, so it is named here instead.
 */
const EXCLUDED_CALLS = /^(console\.|logger\.|warnings\.push$|netPrewarmSettle$)/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

const STRING_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.JsxText,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
]);

/** Every em dash that sits in a string rather than a comment. */
function offenders(file: string): string[] {
  const src = fs.readFileSync(file, 'utf8');
  if (!src.includes(EM_DASH)) return [];
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];

  const visit = (n: ts.Node): void => {
    const text = (n as ts.LiteralLikeNode).text;
    if (STRING_KINDS.has(n.kind) && typeof text === 'string' && text.includes(EM_DASH)) {
      // Walk out to the nearest call to see whether this is a logging sink.
      let p: ts.Node | undefined = n.parent;
      let logged = false;
      while (p && !logged) {
        if (ts.isCallExpression(p) && EXCLUDED_CALLS.test(p.expression.getText(sf))) logged = true;
        p = p.parent;
      }
      if (!logged) {
        const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
        const rel = path.relative(path.resolve(__dirname, '../..'), file);
        found.push(`${rel}:${line + 1}  ${text.replace(/\s+/g, ' ').trim().slice(0, 80)}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

describe('no em dash in user-facing text', () => {
  const files = sourceFiles(SRC)
    .filter((f) => !EXCLUDED_FILES(path.relative(SRC, f).split(path.sep).join('/')));

  it('has files to scan, so a broken walk cannot pass everything', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('still sees the em dashes it is meant to skip, so the filter is not the reason it passes', () => {
    // If the exclusions ever grow to cover everything, or the AST walk stops
    // finding strings at all, this suite would go green for the wrong reason.
    // The injected scripts are known to carry em dashes in their comments.
    const known = path.join(SRC, 'lib/webview-scripts');
    const withEmDash = fs.readdirSync(known)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => fs.readFileSync(path.join(known, f), 'utf8').includes(EM_DASH));
    expect(withEmDash.length).toBeGreaterThan(0);
    // ...and at least one of them WOULD be reported were it not excluded. Not
    // all of them: an em dash in a plain `//` comment above the code is invisible
    // to the AST walk by design, and several of these files carry only that
    // kind. What the canary needs is one file whose em dash is inside the
    // emitted script TEXT, which is the case the exclusion actually exists for.
    const reported = withEmDash.filter((f) => offenders(path.join(known, f)).length > 0);
    expect(reported.length).toBeGreaterThan(0);
  });

  it('finds none', () => {
    const all = files.flatMap(offenders);
    // Replace it rather than swapping in a hyphen. An em dash is doing one of
    // three jobs and each has a plain form: a parenthetical becomes commas or
    // brackets, a pause before a conclusion becomes a full stop, and a range or
    // label becomes a colon or the word "to".
    expect(all).toEqual([]);
  });
});
