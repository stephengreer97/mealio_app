import { mergeAutomationConfig } from '../../src/lib/automation-config/merge';
import { BUNDLED_AUTOMATION_CONFIG } from '../../src/lib/automation-config/schema';

// merge.ts is the trust boundary for config that arrives over the network and
// then (a) drives timers and (b) gets interpolated into JavaScript injected into a
// store's page. These tests are mostly about REFUSAL: what the merge must decline
// to believe, and the guarantee that a bad field degrades to the bundled default
// instead of taking the config down with it.

describe('mergeAutomationConfig', () => {
  it('returns the bundled config unchanged for an empty override', () => {
    const { config, warnings } = mergeAutomationConfig({});
    expect(config).toEqual(BUNDLED_AUTOMATION_CONFIG);
    expect(warnings).toEqual([]);
  });

  it('returns bundled defaults for null/undefined/non-object input', () => {
    for (const bad of [null, undefined, 42, 'nope', [1, 2, 3]]) {
      const { config } = mergeAutomationConfig(bad);
      expect(config.timeouts.addMs).toBe(BUNDLED_AUTOMATION_CONFIG.timeouts.addMs);
    }
  });

  it('never mutates the bundled config', () => {
    const before = JSON.parse(JSON.stringify(BUNDLED_AUTOMATION_CONFIG));
    mergeAutomationConfig({ timeouts: { addMs: 30_000 }, stores: { heb: { selectors: { title: '.x' } } } });
    expect(BUNDLED_AUTOMATION_CONFIG).toEqual(before);
  });

  it('applies a valid scalar override', () => {
    const { config, warnings } = mergeAutomationConfig({ timeouts: { addMs: 25_000 } });
    expect(config.timeouts.addMs).toBe(25_000);
    // Untouched siblings keep their bundled values.
    expect(config.timeouts.searchMs).toBe(BUNDLED_AUTOMATION_CONFIG.timeouts.searchMs);
    expect(warnings).toEqual([]);
  });

  it('rejects a number outside its declared bounds and keeps the default', () => {
    // A 100ms add timeout would fail every single run. Refusing beats clamping to
    // a value nobody chose, because the refusal is visible in warnings.
    const { config, warnings } = mergeAutomationConfig({ timeouts: { addMs: 100 } });
    expect(config.timeouts.addMs).toBe(BUNDLED_AUTOMATION_CONFIG.timeouts.addMs);
    expect(warnings.join()).toMatch(/timeouts.addMs.*outside/);
  });

  it('rejects an absurdly large timeout too', () => {
    const { config } = mergeAutomationConfig({ timeouts: { searchMs: 10 * 60 * 1000 } });
    expect(config.timeouts.searchMs).toBe(BUNDLED_AUTOMATION_CONFIG.timeouts.searchMs);
  });

  it('rejects a wrong-typed value and keeps the default', () => {
    const { config, warnings } = mergeAutomationConfig({
      timeouts: { addMs: '25000' },
      flags: { parallelAdd: 'yes' },
    });
    expect(config.timeouts.addMs).toBe(BUNDLED_AUTOMATION_CONFIG.timeouts.addMs);
    expect(config.flags.parallelAdd).toBe(BUNDLED_AUTOMATION_CONFIG.flags.parallelAdd);
    expect(warnings.length).toBe(2);
  });

  it('rejects NaN and Infinity', () => {
    const { config } = mergeAutomationConfig({ timeouts: { addMs: NaN }, flags: { addCommitJitterMs: Infinity } });
    expect(config.timeouts.addMs).toBe(BUNDLED_AUTOMATION_CONFIG.timeouts.addMs);
    expect(config.flags.addCommitJitterMs).toBe(BUNDLED_AUTOMATION_CONFIG.flags.addCommitJitterMs);
  });

  it('ignores unknown keys but still applies valid siblings', () => {
    // The whole point: a newer server can publish fields this build predates.
    const { config, warnings } = mergeAutomationConfig({
      timeouts: { addMs: 20_000, someFutureKnob: 5 },
      totallyNewSection: { a: 1 },
    });
    expect(config.timeouts.addMs).toBe(20_000);
    expect(warnings.join()).toMatch(/someFutureKnob.*unknown/);
    expect(warnings.join()).toMatch(/totallyNewSection.*unknown top-level/);
  });

  it('one bad field does not block the rest of the tree', () => {
    const { config } = mergeAutomationConfig({
      timeouts: { addMs: 1, searchMs: 20_000 },
      stores: { heb: { selectors: { title: ".broken'quote", productCard: '.good' } } },
    });
    expect(config.timeouts.addMs).toBe(BUNDLED_AUTOMATION_CONFIG.timeouts.addMs); // refused
    expect(config.timeouts.searchMs).toBe(20_000);                                // applied
    expect(config.stores.heb.selectors!.title).toBe(BUNDLED_AUTOMATION_CONFIG.stores.heb.selectors!.title);
    expect(config.stores.heb.selectors!.productCard).toBe('.good');
  });

  describe('selector safety (these values get interpolated into injected JS)', () => {
    const badSelectors: Array<[string, string]> = [
      ['single quote', "button[aria-label='x']"],
      ['double quote', 'button[aria-label="x"] "'],
      ['backslash', 'button\\x'],
      ['backtick', 'button`x'],
      ['template expr', 'button${alert(1)}'],
      ['angle bracket / tag', '</script><script>alert(1)</script>'],
      ['newline', 'button\nx'],
      ['line separator', 'button x'],
      ['empty', ''],
      ['whitespace only', '   '],
    ];

    for (const [name, value] of badSelectors) {
      it(`rejects a selector containing ${name}`, () => {
        const { config, warnings } = mergeAutomationConfig({
          stores: { albertsons: { selectors: { atc: value } } },
        });
        expect(config.stores.albertsons.selectors!.atc)
          .toBe(BUNDLED_AUTOMATION_CONFIG.stores.albertsons.selectors!.atc);
        expect(warnings.join()).toMatch(/unsafe or empty selector/);
      });
    }

    it('accepts an ordinary attribute selector without quotes', () => {
      const { config, warnings } = mergeAutomationConfig({
        stores: { albertsons: { selectors: { atc: 'button[aria-label^=Add], .new-atc-class' } } },
      });
      expect(config.stores.albertsons.selectors!.atc).toBe('button[aria-label^=Add], .new-atc-class');
      expect(warnings).toEqual([]);
    });

    it('accepts a brand-new selector key', () => {
      // Lets us stage a selector for markup the current build doesn't reference
      // yet, ready for the release that starts using it.
      const { config } = mergeAutomationConfig({
        stores: { albertsons: { selectors: { futureThing: '.thing' } } },
      });
      expect(config.stores.albertsons.selectors!.futureThing).toBe('.thing');
    });

    it('rejects a selector far over the length cap', () => {
      const { config } = mergeAutomationConfig({
        stores: { albertsons: { selectors: { atc: '.a'.repeat(400) } } },
      });
      expect(config.stores.albertsons.selectors!.atc)
        .toBe(BUNDLED_AUTOMATION_CONFIG.stores.albertsons.selectors!.atc);
    });
  });

  describe('URL safety', () => {
    it('accepts an https URL', () => {
      const { config } = mergeAutomationConfig({ stores: { heb: { cartUrl: 'https://www.heb.com/basket' } } });
      expect(config.stores.heb.cartUrl).toBe('https://www.heb.com/basket');
    });

    it('rejects http (would downgrade the store to cleartext)', () => {
      const { config, warnings } = mergeAutomationConfig({ stores: { heb: { cartUrl: 'http://www.heb.com/cart' } } });
      expect(config.stores.heb.cartUrl).toBe(BUNDLED_AUTOMATION_CONFIG.stores.heb.cartUrl);
      expect(warnings.join()).toMatch(/not a safe https URL/);
    });

    it('rejects javascript: and data: URLs', () => {
      for (const bad of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>']) {
        const { config } = mergeAutomationConfig({ stores: { heb: { loginUrl: bad } } });
        expect(config.stores.heb.loginUrl).toBe(BUNDLED_AUTOMATION_CONFIG.stores.heb.loginUrl);
      }
    });

    it('requires {term} in a searchUrlTemplate', () => {
      // Without the placeholder every search would load the same page, and the
      // run would add whatever happened to be on it — silently wrong, not broken.
      const { config, warnings } = mergeAutomationConfig({
        stores: { heb: { searchUrlTemplate: 'https://www.heb.com/search' } },
      });
      expect(config.stores.heb.searchUrlTemplate)
        .toBe(BUNDLED_AUTOMATION_CONFIG.stores.heb.searchUrlTemplate);
      expect(warnings.join()).toMatch(/\{term\}/);
    });

    it('accepts a searchUrlTemplate containing {term}', () => {
      const { config } = mergeAutomationConfig({
        stores: { heb: { searchUrlTemplate: 'https://www.heb.com/find?query={term}' } },
      });
      expect(config.stores.heb.searchUrlTemplate).toBe('https://www.heb.com/find?query={term}');
    });
  });

  describe('store entries', () => {
    it('applies the enabled kill switch', () => {
      const { config } = mergeAutomationConfig({ stores: { aldi: { enabled: false } } });
      expect(config.stores.aldi.enabled).toBe(false);
    });

    it('accepts a store the bundle does not know about', () => {
      const { config } = mergeAutomationConfig({ stores: { newstore: { enabled: false } } });
      expect(config.stores.newstore).toEqual({ enabled: false });
    });

    it('truncates a fractional workerCount to an integer', () => {
      const { config } = mergeAutomationConfig({ stores: { heb: { workerCount: 4.7 } } });
      expect(config.stores.heb.workerCount).toBe(4);
    });

    it('rejects a workerCount above the cap', () => {
      const { config, warnings } = mergeAutomationConfig({ stores: { heb: { workerCount: 50 } } });
      expect(config.stores.heb.workerCount).toBeUndefined();
      expect(warnings.join()).toMatch(/workerCount/);
    });

    it('ignores a non-object store entry', () => {
      const { config, warnings } = mergeAutomationConfig({ stores: { heb: 'nope' } });
      expect(config.stores.heb).toEqual(BUNDLED_AUTOMATION_CONFIG.stores.heb);
      expect(warnings.join()).toMatch(/stores.heb.*expected an object/);
    });

    it('ignores a non-object stores section', () => {
      const { config, warnings } = mergeAutomationConfig({ stores: [1, 2] });
      expect(config.stores).toEqual(BUNDLED_AUTOMATION_CONFIG.stores);
      expect(warnings.join()).toMatch(/stores.*expected an object/);
    });
  });

  it('applies telemetry knobs within bounds and refuses outside', () => {
    const { config } = mergeAutomationConfig({ telemetry: { sampleRate: 0.25, batchSize: 500 } });
    expect(config.telemetry.sampleRate).toBe(0.25);
    expect(config.telemetry.batchSize).toBe(BUNDLED_AUTOMATION_CONFIG.telemetry.batchSize);
  });

  it('allows a sampleRate of exactly 0 (telemetry fully off)', () => {
    // 0 is a legitimate value and must not be confused with "missing".
    const { config } = mergeAutomationConfig({ telemetry: { sampleRate: 0 } });
    expect(config.telemetry.sampleRate).toBe(0);
  });
});
