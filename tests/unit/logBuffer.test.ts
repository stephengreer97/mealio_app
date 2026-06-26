import { redactLogLine } from '../../src/lib/logBuffer';

describe('redactLogLine (Option B: strip secrets + all PII)', () => {
  it('masks product names in cart kv logs, keeps store/step/success/reason', () => {
    const line =
      '19:33:05 LOG [Cart 19:33:05] ADD WORKER_RESULT w 2 success= true product= H-E-B Mi Tienda Dried Chile Guajillo Peppers, 4 oz reason= null';
    const out = redactLogLine(line);
    expect(out).not.toMatch(/Guajillo|Chile|Tienda/i);
    expect(out).toContain('‹redacted›');
    // Useful, non-PII diagnostic fields survive.
    expect(out).toContain('success= true');
    expect(out).toContain('reason= null');
    expect(out).toContain('WORKER_RESULT w 2');
  });

  it('masks bestName / searchTerm but keeps step + store', () => {
    const line =
      '[Cart] navigateToSearchItem idx= 0 term= CAFE Olé Coffee, 12 oz hasSearchTerm= true store= heb step= searching';
    const out = redactLogLine(line);
    expect(out).not.toMatch(/CAFE|Coffee/i);
    expect(out).toContain('store= heb');
    expect(out).toContain('step= searching');
    expect(out).toContain('hasSearchTerm= true');
  });

  it('redacts product/name fields inside JSON cart snapshots', () => {
    const line =
      'onMessage CART_COUNT {"count": 24, "items": [{"name": "H-E-B Dr. B Soda 12 pk Cans, 12 oz", "qty": 2}]}';
    const out = redactLogLine(line);
    expect(out).not.toMatch(/Soda|Cans/i);
    expect(out).toContain('"name":"‹redacted›"');
    expect(out).toContain('"count": 24'); // counts are fine
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
