// MEAL-16 — the H-E-B cart-query probe ladder.
//
// Five diagnostic GraphQL reads, once per run, whose whole job is to separate
// the two surviving readings of the 2026-08-10 run: either our sub-selection
// never reaches H-E-B's validator, or the schema behind our request is not the
// storefront's. See the ladder's header in webview-scripts/heb-cart-query for
// what each rung is worth.
//
// Same technique as hebCartQuery.test.ts: the ladder exists only as the
// injectable JS string, so these tests evaluate that string in a sandbox rather
// than re-implementing any of it in TypeScript.

import * as vm from 'vm';

import {
  loadAutomationConfig,
  __resetAutomationConfigForTests,
} from '../../src/lib/automation-config';
import {
  buildHebCartProbeScript,
  HEB_CART_OPERATION,
  HEB_CART_OPERATION_ALT,
  HEB_CART_PROBES,
  HEB_CART_PROBE_FIELD,
  HEB_CART_QUERY,
  HEB_CART_QUERY_ALT,
  HEB_CART_QUERY_ANON,
} from '../../src/lib/webview-scripts/heb-cart-query';

beforeEach(() => __resetAutomationConfigForTests());
afterAll(() => __resetAutomationConfigForTests());

// ── The documents ────────────────────────────────────────────────────────────

describe('the production document', () => {
  // The split into `query <name>` + selection set is what lets rungs 4 and 5 be
  // provably the same document under a different name. It also had to leave the
  // production text alone character for character: the gateway's own complaint
  // is `loc 2:3`, which is a statement about where cartV2 sits in THIS string,
  // and every reading of that run rests on it.
  it('is unchanged by the split, character for character', () => {
    expect(HEB_CART_QUERY).toBe(
      'query CartLines {\n' +
      '  cartV2 {\n' +
      '    id\n' +
      '    itemCount { total }\n' +
      '    items {\n' +
      '      id\n' +
      '      quantity\n' +
      '      estimatedWeight\n' +
      '      product { id fullDisplayName }\n' +
      '      sku { id twelveDigitUPC weightSelectionIncrements }\n' +
      '    }\n' +
      '  }\n' +
      '}'
    );
  });

  it('puts cartV2 at line 2, column 3 — the position H-E-B reported back', () => {
    const line = HEB_CART_QUERY.split('\n')[1];
    expect(line.indexOf('cartV2')).toBe(2); // 0-indexed column 2 = 1-indexed 3
  });
});

describe('the renamed and anonymous documents', () => {
  // The point of both rungs is that ONLY the operation name differs. If a future
  // edit to the selection set reached one and not the other, the rung would
  // still run and would still report — it would just be answering a different
  // question than the one the log line claims.
  const strip = (q: string) => q.replace(/^query(\s+\w+)?\s/, '');

  it('carry the production selection set verbatim', () => {
    expect(strip(HEB_CART_QUERY_ALT)).toBe(strip(HEB_CART_QUERY));
    expect(strip(HEB_CART_QUERY_ANON)).toBe(strip(HEB_CART_QUERY));
  });

  it('differ from it only in the operation name', () => {
    expect(HEB_CART_QUERY_ALT).toBe(
      HEB_CART_QUERY.replace(`query ${HEB_CART_OPERATION}`, `query ${HEB_CART_OPERATION_ALT}`)
    );
    expect(HEB_CART_QUERY_ANON).toBe(HEB_CART_QUERY.replace(`query ${HEB_CART_OPERATION} `, 'query '));
  });

  it('name nothing that identifies us', () => {
    expect(HEB_CART_OPERATION_ALT).not.toMatch(/mealio/i);
  });
});

describe('the ladder', () => {
  const byName = (n: string) => HEB_CART_PROBES.find((p) => p.name === n)!;

  it('is the five rungs the ticket names, in order', () => {
    expect(HEB_CART_PROBES.map((p) => p.name)).toEqual([
      'control', 'minimal', 'discriminator', 'renamed', 'anonymous',
    ]);
  });

  it('sends a control that carries nothing of ours', () => {
    const c = byName('control');
    expect(c.body).toEqual({ query: 'query { __typename }' });
  });

  it('asks the discriminator for a field that cannot exist', () => {
    const d = byName('discriminator');
    // The absent field's name has to appear in the document, because the whole
    // reading is "does their answer quote it back at us".
    expect(String(d.body.query)).toContain(HEB_CART_PROBE_FIELD);
    expect(String(d.body.query)).toContain('cartV2');
  });

  it('holds the operation name steady across the selection-set rungs', () => {
    // Rungs 2-4 vary the SELECTION SET with the name fixed; rungs 4-5 and the
    // run's own reads vary the name with the document fixed. A rung that varied
    // both would settle neither axis.
    expect(byName('minimal').body.operationName).toBe(HEB_CART_OPERATION_ALT);
    expect(byName('discriminator').body.operationName).toBe(HEB_CART_OPERATION_ALT);
    expect(byName('renamed').body.operationName).toBe(HEB_CART_OPERATION_ALT);
  });

  it('sends NOTHING under the live operation name', () => {
    // Rung 3's document is invalid on purpose. If the name-keyed response this
    // ladder exists to test for is real, sending that under `CartLines` could
    // install a 400 against the operation the run's own cart reads use — a
    // diagnostic corrupting the run it is measuring. Nothing is lost: the answer
    // under the live name is already on every cart_query_confirm line.
    for (const p of HEB_CART_PROBES) {
      expect(p.body.operationName).not.toBe(HEB_CART_OPERATION);
      expect(String(p.body.query)).not.toContain(`query ${HEB_CART_OPERATION} `);
      expect(String(p.body.query)).not.toContain(`query ${HEB_CART_OPERATION}{`);
    }
  });

  it('sends the anonymous rung with no operationName KEY at all', () => {
    const a = byName('anonymous');
    // Not merely null/empty: an anonymous operation announced in the envelope is
    // a different request from an unannounced one, and the rung is only worth
    // sending as the latter.
    expect('operationName' in a.body).toBe(false);
    expect(a.body.query).toBe(HEB_CART_QUERY_ANON);
  });

  it('sends the renamed rung under the alternate name on both sides', () => {
    const r = byName('renamed');
    expect(r.body.operationName).toBe(HEB_CART_OPERATION_ALT);
    expect(r.body.query).toBe(HEB_CART_QUERY_ALT);
  });
});

// ── The script ───────────────────────────────────────────────────────────────

it('parses as valid JS', () => {
  expect(() => new vm.Script(buildHebCartProbeScript('p1'))).not.toThrow();
});

interface StubResponse {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

/** Run the ladder in a sandbox. `answer` is called per rung, in send order. */
async function runLadder(
  answer: (call: { url: string; init: any; index: number }) => StubResponse | Promise<StubResponse> | never,
  opts: { noBridge?: boolean; runTwice?: boolean; id?: string } = {}
): Promise<{ posted: any[]; calls: { url: string; init: any }[] }> {
  const posted: any[] = [];
  const calls: { url: string; init: any }[] = [];
  let done: () => void = () => {};
  const finished = new Promise<void>((r) => { done = r; });

  const sandbox: Record<string, unknown> = {
    setTimeout,
    clearTimeout,
    AbortController,
    JSON,
    Promise,
    String,
    Object,
    Error,
    fetch: async (url: string, init: any) => {
      const index = calls.length;
      calls.push({ url, init });
      const res = await answer({ url, init, index });
      return {
        status: res.status,
        headers: { get: (n: string) => (res.headers ? res.headers[n.toLowerCase()] ?? null : null) },
        text: async () => res.body,
      };
    },
  };
  if (!opts.noBridge) {
    sandbox.window = {
      ReactNativeWebView: {
        postMessage: (s: string) => {
          const msg = JSON.parse(s);
          posted.push(msg);
          if (msg.step === 'cart_query_probe_done' || msg.step === 'cart_query_probe_error') done();
        },
      },
    };
  } else {
    sandbox.window = {};
    // Nothing will ever post, so end the wait on the next tick instead.
    setTimeout(done, 0);
  }

  vm.runInNewContext(buildHebCartProbeScript(opts.id ?? 'p1'), sandbox);
  if (opts.runTwice) vm.runInNewContext(buildHebCartProbeScript('p2'), sandbox);
  // The bail-out timer is CLEARED either way — a pending 5 s handle would keep
  // the whole jest worker alive after the suite passed.
  let bail: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      finished,
      new Promise<void>((_, reject) => {
        bail = setTimeout(() => reject(new Error('ladder never finished')), 5000);
      }),
    ]);
  } finally {
    if (bail) clearTimeout(bail);
  }
  return { posted, calls };
}

const GQL_ERROR = JSON.stringify({
  errors: [{
    message: 'Field "cartV2" of type "Query" must have a selection of subfields. Did you mean "cartV2 { ... }"?',
    locations: [{ line: 2, column: 3 }],
    extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
  }],
});

describe('running the ladder', () => {
  it('sends every rung once, to the cart endpoint, as an authenticated POST', async () => {
    const { calls } = await runLadder(() => ({ status: 400, body: GQL_ERROR }));
    expect(calls).toHaveLength(HEB_CART_PROBES.length);
    for (const c of calls) {
      expect(c.url).toBe('/graphql');
      expect(c.init.method).toBe('POST');
      // Cookies are the whole reason this runs in the page and not from RN.
      expect(c.init.credentials).toBe('include');
      expect(c.init.headers['content-type']).toBe('application/json');
    }
  });

  it('sends the rungs in order, with each rung\'s own body', async () => {
    const { calls } = await runLadder(() => ({ status: 400, body: GQL_ERROR }));
    expect(calls.map((c) => JSON.parse(c.init.body))).toEqual(HEB_CART_PROBES.map((p) => p.body));
  });

  it('sends them ONE AT A TIME', async () => {
    // Concurrency would be faster and would survive a navigation better, but
    // rungs 2 and 3 share an operation name — so if the answer really is keyed
    // or cached on that name, two concurrent requests carrying it are the one
    // shape that could make the discriminator report the minimal rung's answer.
    let inFlight = 0;
    let maxInFlight = 0;
    await runLadder(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return { status: 400, body: GQL_ERROR };
    });
    expect(maxInFlight).toBe(1);
  });

  it('posts one line per rung plus a done line', async () => {
    const { posted } = await runLadder(() => ({ status: 400, body: GQL_ERROR }));
    const rungs = posted.filter((m) => m.step === 'cart_query_probe');
    expect(rungs.map((m) => m.probe)).toEqual(HEB_CART_PROBES.map((p) => p.name));
    expect(posted[posted.length - 1]).toMatchObject({
      step: 'cart_query_probe_done', ran: HEB_CART_PROBES.length, of: HEB_CART_PROBES.length,
    });
    for (const m of rungs) expect(m.type).toBe('EXTRACT_DEBUG');
  });

  it('reports status, code, locations and the message off a GraphQL error', async () => {
    const { posted } = await runLadder(() => ({ status: 400, body: GQL_ERROR }));
    const first = posted[0];
    expect(first.status).toBe(400);
    expect(first.code).toBe('GRAPHQL_VALIDATION_FAILED');
    expect(first.loc).toBe('2:3');
    expect(first.errN).toBe(1);
    expect(first.msg).toContain('must have a selection of subfields');
  });

  it('carries the raw body and the edge headers — where a cached 400 shows itself', async () => {
    const { posted } = await runLadder(() => ({
      status: 400,
      body: GQL_ERROR,
      headers: { server: 'nginx', via: '1.1 varnish', 'x-cache': 'HIT', age: '412' },
    }));
    expect(posted[0].raw).toContain('GRAPHQL_VALIDATION_FAILED');
    expect(posted[0].hdr).toEqual({ server: 'nginx', via: '1.1 varnish', 'x-cache': 'HIT', age: '412' });
  });

  it('caps the raw body at 400 characters and collapses its whitespace', async () => {
    const { posted } = await runLadder(() => ({ status: 500, body: `{\n  "x": "${'y'.repeat(900)}"\n}` }));
    expect(posted[0].raw).toHaveLength(400);
    expect(posted[0].raw).not.toContain('\n');
  });

  it('names what came back in data — including the control\'s root type', async () => {
    const { posted } = await runLadder(({ index }) => (index === 0
      ? { status: 200, body: JSON.stringify({ data: { __typename: 'Query' } }) }
      : { status: 400, body: GQL_ERROR }));
    // The one field that speaks to reading B without any interpretation: the
    // gateway's complaint calls cartV2's type `Query`, and this says what the
    // root type of the schema answering us actually is.
    expect(posted[0].data).toBe('__typename=Query');
    expect(posted[0].status).toBe(200);
    expect(posted[0].code).toBeNull();
  });

  it('distinguishes a null cart from an absent data key', async () => {
    const { posted } = await runLadder(({ index }) => (index === 1
      ? { status: 200, body: JSON.stringify({ data: { cartV2: null } }) }
      : { status: 400, body: GQL_ERROR }));
    expect(posted[1].data).toBe('cartV2=null');
    expect(posted[0].data).toBe('no_data');
  });

  it('reads the discriminator\'s answer when the gateway names a real type', async () => {
    // The reading that kills candidate A: their validator quoted our absent
    // field back and named the type it looked it up on.
    const answer = JSON.stringify({
      errors: [{
        message: `Cannot query field "${HEB_CART_PROBE_FIELD}" on type "Cart".`,
        locations: [{ line: 1, column: 27 }],
        extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
      }],
    });
    const { posted } = await runLadder(({ index }) => (index === 2
      ? { status: 400, body: answer }
      : { status: 400, body: GQL_ERROR }));
    const disc = posted.find((m) => m.probe === 'discriminator');
    expect(disc.msg).toContain(HEB_CART_PROBE_FIELD);
    expect(disc.msg).toContain('on type "Cart"');
    expect(disc.loc).toBe('1:27');
  });

  it('reports the document it actually sent, per rung', async () => {
    const { posted } = await runLadder(() => ({ status: 400, body: GQL_ERROR }));
    const anon = posted.find((m) => m.probe === 'anonymous');
    // Whitespace-collapsed, so the line stays one line — but still the text.
    expect(anon.q).toBe(HEB_CART_QUERY_ANON.replace(/\s+/g, ' ').slice(0, 300));
    expect(anon.op).toBeNull();
    expect(posted.find((m) => m.probe === 'renamed').op).toBe(HEB_CART_OPERATION_ALT);
  });

  it('keeps going when a rung throws, and says so on that rung', async () => {
    // A rung that fails is a reading, not a reason to abandon the four that did
    // not — and the ladder's value is in comparing rungs to each other.
    const { posted, calls } = await runLadder(({ index }) => {
      if (index === 1) throw new Error('Network request failed');
      return { status: 400, body: GQL_ERROR };
    });
    expect(calls).toHaveLength(HEB_CART_PROBES.length);
    expect(posted[1].err).toContain('Network request failed');
    expect(posted[1].status).toBeNull();
    expect(posted[2].status).toBe(400);
    expect(posted[posted.length - 1].ran).toBe(HEB_CART_PROBES.length);
  });

  it('survives a body that is not JSON at all', async () => {
    const { posted } = await runLadder(() => ({ status: 403, body: '<!doctype html><html>Pardon Our Interruption</html>' }));
    expect(posted[0].status).toBe(403);
    expect(posted[0].data).toBe('no_json');
    expect(posted[0].raw).toContain('Pardon Our Interruption');
    expect(posted[0].err).toBeNull();
  });

  it('survives a response with no readable headers', async () => {
    const { posted } = await runLadder(() => ({ status: 400, body: GQL_ERROR }));
    expect(posted[0].hdr).toEqual({});
  });

  it('stamps its id on every line it posts', async () => {
    // The native side runs more than one ladder per run (it retries one that
    // never finished), so a done line without an id would retire whichever record
    // happened to be outstanding — including a later ladder still running.
    const { posted } = await runLadder(() => ({ status: 400, body: GQL_ERROR }), { id: 'p2' });
    expect(posted.length).toBeGreaterThan(HEB_CART_PROBES.length);
    for (const m of posted) expect(m.probeId).toBe('p2');
  });

  it('runs ONE ladder per document, whatever the native side injects', async () => {
    // onLoadEnd fires for H-E-B's same-URL cart re-render and for SPA route
    // changes that never replace the document, so no native rule can tell whether
    // the previous ladder is still alive. The document itself carries the
    // interlock — two ladders in one context would put concurrent CartLinesAlt
    // requests on the wire, the shape the rungs are sequential to avoid.
    const { posted, calls } = await runLadder(() => ({ status: 400, body: GQL_ERROR }), { runTwice: true });
    expect(calls).toHaveLength(HEB_CART_PROBES.length);
    expect(posted.filter((m) => m.probeId === 'p2')).toEqual([]);
  });

  it('does nothing at all without the bridge', async () => {
    // The rail's own module is evaluated in a sandbox with no window and no
    // bridge, and a diagnostic that throws there would take it down with it.
    const { posted, calls } = await runLadder(() => ({ status: 400, body: GQL_ERROR }), { noBridge: true });
    expect(posted).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('the endpoint override', () => {
  it('follows the remote cart endpoint, like the rail itself', async () => {
    await loadAutomationConfig(async () => ({
      version: 21,
      config: { stores: { heb: { cartEndpoint: '/api/graphql' } } },
    }));
    const { calls } = await runLadder(() => ({ status: 400, body: GQL_ERROR }));
    expect(calls[0].url).toBe('/api/graphql');
  });

  it('refuses an off-origin endpoint and probes the one we shipped with', async () => {
    await loadAutomationConfig(async () => ({
      version: 22,
      config: { stores: { heb: { cartEndpoint: 'https://evil.example/graphql' } } },
    }));
    const { calls } = await runLadder(() => ({ status: 400, body: GQL_ERROR }));
    expect(calls[0].url).toBe('/graphql');
  });
});
