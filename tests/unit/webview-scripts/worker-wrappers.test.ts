// The generic worker wrappers, tested on their own contract: which fields of a
// store's SEARCH_RESULT they carry through onto WORKER_RESULT.
//
// This is easy to get wrong invisibly. A wrapper that forwards `candidates` and
// nothing else still looks perfect in every extraction test — products come back,
// the pool advances — while quietly deleting the metadata the funnel needs. That
// is exactly what happened to MEAL-13's `source`: it reached RN from the main
// WebView and from nowhere else, so `candidatesDetail.source` read as empty for
// every parallel search, which is indistinguishable from the flag being off.
//
// Run in a bare vm rather than through Playwright: the wrappers are store-agnostic
// string plumbing, so a stub extractor pins them for ALL stores at once, and the
// per-store proof that the real script emits `source` lives in heb.spec.ts.

import * as vm from 'vm';
import {
  buildPresearchWorker,
  buildExtractWorker,
} from '../../../src/lib/webview-scripts/worker-search';

/** A stand-in extract script that posts one SEARCH_RESULT with the given extras. */
function stubExtract(extra: Record<string, unknown>): string {
  return `window.ReactNativeWebView.postMessage(JSON.stringify(Object.assign(
    { type: 'SEARCH_RESULT', candidates: [{ productName: 'H-E-B Regular Sour Cream, 16 oz' }] },
    ${JSON.stringify(extra)}
  )));`;
}

/** Run a wrapped script in a fake WebView and return everything it posted. */
function runWrapped(script: string): Array<Record<string, any>> {
  const posted: Array<Record<string, any>> = [];
  const window: any = {
    ReactNativeWebView: { postMessage: (s: string) => posted.push(JSON.parse(s)) },
  };
  vm.createContext(window);
  window.window = window;
  vm.runInContext(script, window);
  return posted;
}

const WRAPPERS: Array<[string, (id: number, script: string) => string]> = [
  ['buildPresearchWorker', buildPresearchWorker],
  ['buildExtractWorker', buildExtractWorker],
];

describe.each(WRAPPERS)('%s forwards the search metadata', (_name, wrap) => {
  it('carries `source` onto WORKER_RESULT', () => {
    const posted = runWrapped(wrap(4, stubExtract({ source: 'next_data' })));
    const result = posted.find((m) => m.type === 'WORKER_RESULT')!;
    expect(result).toBeDefined();
    expect(result.workerId).toBe(4);
    expect(result.candidates).toHaveLength(1);
    // The MEAL-13 rollout comparison: which extractor produced these.
    expect(result.source).toBe('next_data');
  });

  it('carries the DOM fallback source too', () => {
    const posted = runWrapped(wrap(0, stubExtract({ source: 'dom' })));
    expect(posted.find((m) => m.type === 'WORKER_RESULT')!.source).toBe('dom');
  });

  it('reports a missing source as null rather than dropping the key', () => {
    // Stores other than HEB post no `source`. An explicit null distinguishes
    // "this store does not report one" from "the wrapper ate it".
    const posted = runWrapped(wrap(1, stubExtract({})));
    const result = posted.find((m) => m.type === 'WORKER_RESULT')!;
    expect(result).toHaveProperty('source', null);
  });

  it('re-tags the extractor debug message, keeping its reason', () => {
    // `why` cannot ride on WORKER_RESULT — the extractor posts it before it knows
    // which source wins — so it arrives as a re-tagged EXTRACT_DEBUG. Dropping
    // that collapses all five fallback reasons into a single source: 'dom'.
    const debug = `window.ReactNativeWebView.postMessage(JSON.stringify(
      { type: 'EXTRACT_DEBUG', step: 'next_data', ndReason: 'stale' }));`;
    const posted = runWrapped(wrap(2, debug + stubExtract({ source: 'dom' })));
    const dbg = posted.find((m) => m.type === 'WORKER_DEBUG')!;
    expect(dbg).toBeDefined();
    expect(dbg.workerId).toBe(2);
    expect(dbg.step).toBe('next_data');
    expect(dbg.ndReason).toBe('stale');
  });
});
