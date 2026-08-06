import { mergeAutomationConfig } from '../../src/lib/automation-config/merge';
import { BUNDLED_AUTOMATION_CONFIG, PLATFORM_IDS } from '../../src/lib/automation-config/schema';

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
    mergeAutomationConfig({
      timeouts: { addMs: 30_000 },
      stores: { heb: { selectors: { title: '.x' } } },
      // The platform table is SHARED by every banner on it, so a merge that
      // mutated the bundled copy would leak across into later reads.
      platforms: { instacart: { selectors: { atc: '.x' } } },
    });
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
    // The same gate is applied at BOTH levels a selector can be published at. A
    // platform-level value reaches every store on the platform, so it is checked
    // identically to a store-level one — the wider blast radius must not come with
    // a looser gate. Each case below runs twice, once per site.
    const sites = [
      {
        label: 'store-level',
        path: 'stores.walmart.selectors.addBtn',
        push: (v: unknown) => ({ stores: { walmart: { selectors: { addBtn: v } } } }),
        read: (c: typeof BUNDLED_AUTOMATION_CONFIG) => c.stores.walmart.selectors!.addBtn,
        bundled: BUNDLED_AUTOMATION_CONFIG.stores.walmart.selectors!.addBtn,
      },
      {
        label: 'platform-level',
        path: 'platforms.albertsons.selectors.atc',
        push: (v: unknown) => ({ platforms: { albertsons: { selectors: { atc: v } } } }),
        read: (c: typeof BUNDLED_AUTOMATION_CONFIG) => c.platforms.albertsons.selectors!.atc,
        bundled: BUNDLED_AUTOMATION_CONFIG.platforms.albertsons.selectors!.atc,
      },
    ];

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

    for (const site of sites) {
      describe(site.label, () => {
        for (const [name, value] of badSelectors) {
          it(`rejects a selector containing ${name}`, () => {
            const { config, warnings } = mergeAutomationConfig(site.push(value));
            expect(site.read(config)).toBe(site.bundled);
            expect(warnings.join()).toMatch(/unsafe or empty selector/);
            // The warning must name the exact path, or an operator cannot tell a
            // refused platform push from a refused store push.
            expect(warnings.join()).toContain(site.path);
          });
        }

        it('accepts an ordinary attribute selector without quotes', () => {
          const { config, warnings } = mergeAutomationConfig(
            site.push('button[aria-label^=Add], .new-atc-class'),
          );
          expect(site.read(config)).toBe('button[aria-label^=Add], .new-atc-class');
          expect(warnings).toEqual([]);
        });

        it('rejects a selector far over the length cap', () => {
          const { config } = mergeAutomationConfig(site.push('.a'.repeat(400)));
          expect(site.read(config)).toBe(site.bundled);
        });

        it('rejects a non-string value', () => {
          const { config } = mergeAutomationConfig(site.push(42));
          expect(site.read(config)).toBe(site.bundled);
        });
      });
    }

    it('accepts a brand-new selector key', () => {
      // Lets us stage a selector for markup the current build doesn't reference
      // yet, ready for the release that starts using it.
      const { config } = mergeAutomationConfig({
        stores: { albertsons: { selectors: { futureThing: '.thing' } } },
      });
      expect(config.stores.albertsons.selectors!.futureThing).toBe('.thing');
    });

    it('accepts a brand-new selector key at platform level too', () => {
      const { config } = mergeAutomationConfig({
        platforms: { instacart: { selectors: { futureThing: '.thing' } } },
      });
      expect(config.platforms.instacart.selectors!.futureThing).toBe('.thing');
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

  // ── MEAL-21: the platform discriminator ────────────────────────────────────
  describe('stores.<id>.platform', () => {
    it('accepts every platform this build knows', () => {
      for (const platform of PLATFORM_IDS) {
        const { config, warnings } = mergeAutomationConfig({ stores: { heb: { platform } } });
        expect(config.stores.heb.platform).toBe(platform);
        expect(warnings).toEqual([]);
      }
    });

    it('refuses an UNRECOGNISED platform and leaves the bundled one in force', () => {
      // The older-app-meets-newer-config case. A build that predates a platform
      // must keep the inheritance it already had, not be pushed off it: refusing
      // means ALDI stays on 'instacart' and keeps resolving those selectors.
      const { config, warnings } = mergeAutomationConfig({
        stores: { aldi: { platform: 'shipt' } },
      });
      expect(config.stores.aldi.platform).toBe('instacart');
      expect(config.platforms.instacart.selectors!.atc)
        .toBe(BUNDLED_AUTOMATION_CONFIG.platforms.instacart.selectors!.atc);
      expect(warnings.join()).toMatch(/stores\.aldi\.platform: not a known platform/);
    });

    it('refuses a non-string platform', () => {
      for (const bad of [42, true, null, {}, ['instacart']]) {
        const { config, warnings } = mergeAutomationConfig({ stores: { aldi: { platform: bad } } });
        expect(config.stores.aldi.platform).toBe('instacart');
        expect(warnings.join()).toMatch(/not a known platform/);
      }
    });

    it('a refused platform does not block valid siblings in the same entry', () => {
      const { config } = mergeAutomationConfig({
        stores: { aldi: { platform: 'nope', enabled: false } },
      });
      expect(config.stores.aldi.platform).toBe('instacart'); // refused
      expect(config.stores.aldi.enabled).toBe(false);        // applied
    });

    it('can classify a store the bundle has never heard of', () => {
      // The point of the field: pre-stage a banner so it inherits the platform
      // table before the release that adds its adapter.
      const { config, warnings } = mergeAutomationConfig({
        stores: { publix: { platform: 'instacart' } },
      });
      expect(config.stores.publix).toEqual({ platform: 'instacart' });
      expect(warnings).toEqual([]);
    });
  });

  describe('the platforms section', () => {
    it('applies a platform-level selector without touching any store entry', () => {
      const { config, warnings } = mergeAutomationConfig({
        platforms: { instacart: { selectors: { atc: '.platform-wide-atc' } } },
      });
      expect(config.platforms.instacart.selectors!.atc).toBe('.platform-wide-atc');
      // Sibling keys in the same platform table survive.
      expect(config.platforms.instacart.selectors!.inc)
        .toBe(BUNDLED_AUTOMATION_CONFIG.platforms.instacart.selectors!.inc);
      // And the store's own table is untouched — inheritance, not replacement.
      expect(config.stores.aldi.selectors).toEqual(BUNDLED_AUTOMATION_CONFIG.stores.aldi.selectors);
      expect(warnings).toEqual([]);
    });

    it('refuses an unknown platform id rather than banking a dead table', () => {
      // Asymmetric with stores on purpose: nothing can attach to it, because
      // stores.<id>.platform refuses the same unknown value.
      const { config, warnings } = mergeAutomationConfig({
        platforms: { shipt: { selectors: { atc: '.x' } } },
      });
      expect(config.platforms.shipt).toBeUndefined();
      expect(config.platforms).toEqual(BUNDLED_AUTOMATION_CONFIG.platforms);
      expect(warnings.join()).toMatch(/platforms\.shipt: not a known platform/);
    });

    it('configures a known platform that ships with no bundled table', () => {
      // 'kroger' has no table in the binary; a push can still stage one.
      const { config, warnings } = mergeAutomationConfig({
        platforms: { kroger: { selectors: { atc: '.kroger-atc' } } },
      });
      expect(config.platforms.kroger.selectors!.atc).toBe('.kroger-atc');
      expect(warnings).toEqual([]);
    });

    it('refuses a non-selector key at platform level', () => {
      // A kill switch or URL here would take out every banner on the platform at
      // once. Those stay per-store by design.
      const { config, warnings } = mergeAutomationConfig({
        platforms: { instacart: { enabled: false, storeUrl: 'https://evil.example' } },
      });
      expect((config.platforms.instacart as Record<string, unknown>).enabled).toBeUndefined();
      expect((config.platforms.instacart as Record<string, unknown>).storeUrl).toBeUndefined();
      expect(warnings.join()).toMatch(/platforms\.instacart\.enabled: unknown key/);
      expect(warnings.join()).toMatch(/platforms\.instacart\.storeUrl: unknown key/);
    });

    it('ignores a non-object platform entry', () => {
      const { config, warnings } = mergeAutomationConfig({ platforms: { instacart: 'nope' } });
      expect(config.platforms.instacart).toEqual(BUNDLED_AUTOMATION_CONFIG.platforms.instacart);
      expect(warnings.join()).toMatch(/platforms\.instacart: expected an object/);
    });

    it('ignores a non-object platforms section', () => {
      const { config, warnings } = mergeAutomationConfig({ platforms: [1, 2] });
      expect(config.platforms).toEqual(BUNDLED_AUTOMATION_CONFIG.platforms);
      expect(warnings.join()).toMatch(/platforms: expected an object/);
    });

    it('ignores a platform selector table over the per-table cap', () => {
      const selectors = Object.fromEntries(
        Array.from({ length: 61 }, (_, i) => [`k${i}`, `.sel-${i}`]),
      );
      const { config, warnings } = mergeAutomationConfig({ platforms: { instacart: { selectors } } });
      expect(config.platforms.instacart.selectors)
        .toEqual(BUNDLED_AUTOMATION_CONFIG.platforms.instacart.selectors);
      expect(warnings.join()).toMatch(/exceeds 60/);
    });

    it('platforms is no longer an unknown top-level section', () => {
      const { warnings } = mergeAutomationConfig({ platforms: {} });
      expect(warnings).toEqual([]);
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
