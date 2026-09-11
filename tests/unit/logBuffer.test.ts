import { redactLogLine } from '../../src/lib/logBuffer';

describe('redactLogLine (Option A: strip secrets + emails, keep product names)', () => {
  it('KEEPS product names + diagnostic fields in cart kv logs', () => {
    const line =
      '19:33:05 LOG [Cart 19:33:05] ADD WORKER_RESULT w 2 success= true product= H-E-B Mi Tienda Dried Chile Guajillo Peppers, 4 oz reason= null';
    const out = redactLogLine(line);
    // Product names are kept — they're the most useful debugging signal.
    expect(out).toContain('H-E-B Mi Tienda Dried Chile Guajillo Peppers, 4 oz');
    expect(out).toContain('success= true');
    expect(out).toContain('reason= null');
  });

  it('KEEPS product/name fields inside JSON cart snapshots', () => {
    const line =
      'onMessage CART_COUNT {"count": 24, "items": [{"name": "H-E-B Dr. B Soda 12 pk Cans, 12 oz", "qty": 2}]}';
    const out = redactLogLine(line);
    expect(out).toContain('H-E-B Dr. B Soda 12 pk Cans, 12 oz');
    expect(out).toContain('"count": 24');
  });

  it('strips JWT access tokens', () => {
    const line =
      'token= eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI5N2UxNDdlYyJ9.4SMlOSPlnSi4blOCcRhc7tKeTaH';
    const out = redactLogLine(line);
    expect(out).not.toMatch(/eyJ/);
    expect(out).toContain('‹');
  });

  it('strips Bearer tokens and Authorization headers', () => {
    expect(redactLogLine('Authorization: Bearer abc123xyz')).not.toContain('abc123xyz');
    expect(redactLogLine('headers {"authorization":"Bearer zzz999"}')).not.toContain('zzz999');
  });

  it('strips password / cookie values', () => {
    expect(redactLogLine('login {"email":"a@b.co","password":"Hunter2!!"}')).not.toContain('Hunter2');
    expect(redactLogLine('cookie= mock_session=ok; trust=abc')).not.toContain('abc');
  });

  it('masks email addresses', () => {
    const out = redactLogLine('login attempt for stephengreer97@gmail.com');
    expect(out).not.toContain('stephengreer97@gmail.com');
    expect(out).toContain('‹email›');
  });

  it('leaves a normal non-PII diagnostic line untouched', () => {
    const line = '[Cart] reconcile: confirmed= 12 retry= 1 review= 0 store= heb';
    expect(redactLogLine(line)).toBe(line);
  });
});

// ── Clipping ────────────────────────────────────────────────────────────────
//
// The capture runs in the SHIPPED app (a bug report attaches getSessionLogs),
// so every console call pays the redaction. Measured 2026-09-11: 0.005ms for a
// typical 180-char line and 0.512ms for the 12.7 KB cart-breakdown lines, of
// which one run writes hundreds. Clipping first is what makes that cheap, and
// it must not become a way for a secret to survive.
describe('long lines are clipped, and clipping cannot leak a secret', () => {
  it('clips a huge line and says how much it cut', () => {
    const huge = `cart rows ${'x'.repeat(20_000)}`;
    const out = redactLogLine(huge.slice(0, 2000));
    expect(out.length).toBeLessThanOrEqual(2100);
  });

  it('redacts a token even when the clip cuts it in half', () => {
    // A real token, truncated mid-signature the way a 2000-char clip would.
    const whole =
      'token= eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI5N2UxNDdlYyJ9.4SMlOSPlnSi4blOCcRhc7tKeTaH';
    const halves = [
      whole,                       // intact
      whole.slice(0, 60),          // cut inside the signature
      whole.slice(0, 34),          // cut inside the payload
      whole.slice(0, 20),          // cut inside the header
    ];
    for (const h of halves) {
      expect(redactLogLine(h)).not.toMatch(/eyJ/);
    }
  });
});
