// The client half of the server's platform-link rule (MEAL-94).
//
// `src/constants/creatorSources.ts` restates what `normalizePlatformUrl` on the
// server accepts, so a typo costs a keystroke instead of a round trip. A copy of
// a rule is only safe in one direction: **looser** than the route is fine
// because the route validates again and its answer is the one that counts, while
// **stricter** turns a save the server would have accepted into a request never
// sent — and the creator has no way around that. Most of what follows is
// therefore about the accepting direction, on the link shapes those platforms
// actually serve.
//
// The cases mirror `tests/lib/creator-sources.test.ts` in mealio_central, so a
// change to the server rule that is not mirrored here shows up as a diff between
// two test files rather than as a creator who cannot save.

import {
  checkPlatformLink,
  polledSource,
  MAX_LINK_CHARS,
  PLATFORM_SOURCES,
  SOURCE_LABELS,
} from '../../src/constants/creatorSources';

/** The error, or '' when the link was accepted — most assertions want one line. */
function why(source: any, raw: string): string {
  const result = checkPlatformLink(source, raw);
  return result.ok ? '' : result.error;
}

describe('checkPlatformLink — what a creator actually types', () => {
  it('accepts a bare hostname and a trailing slash', () => {
    // The two things a real creator types. Rejecting either loses the edit over
    // punctuation; the server fills in the scheme and stores the tidy form.
    expect(checkPlatformLink('website', 'chefsarah.com').ok).toBe(true);
    expect(checkPlatformLink('website', ' https://chefsarah.com/recipes/ ').ok).toBe(true);
  });

  it('treats a blank box as a link nobody typed, not as an error', () => {
    // Blank is how a link is removed, so it can never be a validation failure —
    // whether removing it is allowed is the server's call, and on the polled
    // source it is a pause rather than a refusal.
    for (const source of PLATFORM_SOURCES) {
      expect(checkPlatformLink(source, '').ok).toBe(true);
      expect(checkPlatformLink(source, '   ').ok).toBe(true);
    }
  });

  it('accepts every shape of a platform URL that platform actually serves', () => {
    for (const input of [
      'youtube.com/@sarah',
      'https://www.youtube.com/c/sarah',
      'https://www.youtube.com/user/sarah',
      'https://youtu.be/abc123',
      'm.youtube.com/@sarah',
      'music.youtube.com/channel/UC123',
    ]) {
      expect(why('youtube', input)).toBe('');
    }
    for (const input of ['instagram.com/sarah', 'https://www.instagram.com/sarah/']) {
      expect(why('instagram', input)).toBe('');
    }
    for (const input of ['tiktok.com/@sarah', 'https://vm.tiktok.com/ZM123/', 'https://vt.tiktok.com/ZS456/']) {
      expect(why('tiktok', input)).toBe('');
    }
  });

  it('accepts a website on a subdomain, a port, a path and a query', () => {
    // None of these are the validator's business — it is a host check, and a
    // creator whose blog lives at `blog.chefsarah.com:8443/recipes?page=2` is
    // giving us a perfectly good link.
    for (const input of [
      'blog.chefsarah.com',
      'chefsarah.com:8080',
      'https://chefsarah.com/recipes?page=2#top',
      'https://chefsarah.co.uk/',
    ]) {
      expect(why('website', input)).toBe('');
    }
  });

  it('rejects a link typed into the wrong platform box', () => {
    // Otherwise the mistake surfaces much later, as a viability check that finds
    // no items on a platform the creator never used.
    expect(why('instagram', 'https://youtube.com/@sarah')).toMatch(/not on Instagram/i);
    expect(why('youtube', 'https://vimeo.com/sarah')).toMatch(/not on YouTube/i);
    // The website box is the one that names where the link should have gone.
    expect(why('website', 'https://instagram.com/sarah')).toMatch(/Instagram box/i);
    expect(why('website', 'https://youtu.be/abc')).toMatch(/YouTube box/i);
  });

  it('refuses non-public and non-http links', () => {
    // `mailto:` and `javascript:` matter most: prefixing `https://` onto them
    // produces something that parses cleanly and points somewhere else entirely.
    for (const input of ['localhost:3000', 'http://192.168.1.5/blog', 'javascript:alert(1)', 'mailto:a@b.com']) {
      expect(why('website', input)).not.toBe('');
    }
    expect(why('website', 'localhost')).toMatch(/not a public website/i);
    expect(why('website', 'ftp://files.chefsarah.com')).toMatch(/http:\/\/ or https:\/\//);
  });

  it('reads the host past credentials, which only ever disguise it', () => {
    // `https://chefsarah.com@evil.test/` is a link to evil.test. Reading the
    // host as everything before the `@` would have called it the creator's own
    // site — and in the website box, would have let a YouTube link through.
    expect(why('website', 'https://user:pw@chefsarah.com/blog')).toBe('');
    expect(why('website', 'https://chefsarah.com@youtube.com/@sarah')).toMatch(/YouTube box/i);
    expect(why('youtube', 'https://youtube.com@evil.test/')).toMatch(/not on YouTube/i);
  });

  it('refuses a link too long to be a link, and says how long it was', () => {
    const long = `https://chefsarah.com/${'a'.repeat(MAX_LINK_CHARS)}`;
    expect(why('website', long)).toMatch(new RegExp(`${long.length} characters long`));
    // The boundary itself is accepted — the limit is 2048, not 2047.
    expect(checkPlatformLink('website', `https://chefsarah.com/${'a'.repeat(MAX_LINK_CHARS - 22)}`).ok).toBe(true);
  });

  it('ignores the DNS root’s trailing dot', () => {
    // `chefsarah.com.` and `chefsarah.com` are the same host but compare as
    // different strings, and the server stores the undotted form. A client that
    // rejected the dotted one would block a link the route accepts.
    expect(why('website', 'chefsarah.com.')).toBe('');
    expect(why('youtube', 'https://youtube.com./@sarah')).toBe('');
  });

  it('names the box in the message, because four boxes look alike', () => {
    const result = checkPlatformLink('tiktok', 'https://instagram.com/sarah');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain(SOURCE_LABELS.tiktok);
  });
});

describe('polledSource — the link Mealio actually reads', () => {
  it('needs both halves, because either one alone means nothing is polled', () => {
    // `primary_source` says which of the four *would* be read; `import_opt_in`
    // says whether anything is read at all. A creator with a source set but the
    // import off is not being polled and must not be told they are — that
    // sentence is what warns them that editing the link pauses something.
    expect(polledSource({ primarySource: 'website', importOptIn: true })).toBe('website');
    expect(polledSource({ primarySource: 'website', importOptIn: false })).toBeNull();
    expect(polledSource({ primarySource: 'website', importOptIn: null })).toBeNull();
    expect(polledSource({ primarySource: 'website' })).toBeNull();
    expect(polledSource({ importOptIn: true })).toBeNull();
  });

  it("treats 'none' as the off switch it is", () => {
    expect(polledSource({ primarySource: 'none', importOptIn: true })).toBeNull();
  });

  it('does not trust a source it does not recognise', () => {
    // The column is free text as far as this client is concerned, and a value it
    // cannot label would render "importing from your undefined".
    expect(polledSource({ primarySource: 'mastodon', importOptIn: true })).toBeNull();
    expect(polledSource({ primarySource: '', importOptIn: true })).toBeNull();
  });
});
