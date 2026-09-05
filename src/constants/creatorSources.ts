// Where a creator publishes, and which one of those places Mealio polls.
//
// The mobile half of the web's `lib/creator-sources.ts` (MEAL-94). Only the
// parts a *creator-facing* client can act on are here: the four sources, their
// labels, and the rule that decides whether a link is plausible. The polling
// invariants, the feed/website host pairing and `describeSourceHealth` are
// operator-facing — they are judged on columns (`feed_url`,
// `import_paused_reason`, `import_paused_at`) that `GET /api/creator/me` does
// not return, and they belong to the admin Sources tab.
//
// Ported rather than shared because there is no shared package between the two
// repositories — the same reason `constants/serves.ts` restates the server's
// serves rule. The hazard that comes with a copy is one-directional: a client
// **stricter** than the route it posts to turns a save the server would have
// accepted into a request never sent, which is a bug the creator cannot work
// around. Looser is safe, because the route validates again and its answer is
// the one that counts. Every rule below is therefore written to reject only what
// `normalizePlatformUrl` rejects, and the tests check the accepting direction
// on every link shape those platforms actually serve.

/** The four places a creator can publish. `creators` has a column per entry. */
export const PLATFORM_SOURCES = ['website', 'youtube', 'instagram', 'tiktok'] as const;
export type PlatformSource = (typeof PLATFORM_SOURCES)[number];

export const SOURCE_LABELS: Record<PlatformSource, string> = {
  website: 'Website',
  youtube: 'YouTube',
  instagram: 'Instagram',
  tiktok: 'TikTok',
};

/** Shown in the empty box, so the shape being asked for is never a guess. */
export const SOURCE_PLACEHOLDERS: Record<PlatformSource, string> = {
  website: 'chefsarah.com',
  youtube: 'youtube.com/@chefsarah',
  instagram: 'instagram.com/chefsarah',
  tiktok: 'tiktok.com/@chefsarah',
};

/**
 * Hosts that identify each platform. A *host* check and nothing more: we are
 * confirming the creator pasted the right box's link, not parsing their handle
 * out of it. Path shapes change (`/user/`, `/c/`, `/@name`) and a validator that
 * knows them all rejects real creators the day one changes.
 */
const PLATFORM_HOSTS: Record<PlatformSource, RegExp | null> = {
  website: null, // anything, minus the three below
  youtube: /^(www\.|m\.|music\.)?youtube\.com$|^youtu\.be$/i,
  instagram: /^(www\.)?instagram\.com$/i,
  tiktok: /^(www\.|vm\.|vt\.)?tiktok\.com$/i,
};

const EXAMPLES: Record<PlatformSource, string> = {
  website: 'yourblog.com',
  youtube: 'youtube.com/@yourchannel',
  instagram: 'instagram.com/yourname',
  tiktok: 'tiktok.com/@yourname',
};

/** Longest link the server will normalise or store. */
export const MAX_LINK_CHARS = 2048;

export type LinkCheck = { ok: true } | { ok: false; error: string };

/**
 * The hostname out of a link, without `new URL`.
 *
 * React Native ships a cut-down `URL` whose properties are read-only getters —
 * `hostname`, `username` and `hash` cannot be assigned, so the server's
 * normaliser (which strips credentials and rewrites the host by assignment)
 * cannot be ported as written. Worse, it would look fine: Jest runs against
 * Node's complete WHATWG `URL`, so a verbatim port passes every test here and
 * silently does nothing on a device.
 *
 * So the host is pulled out by hand. Credentials are dropped at the last `@`
 * (a `@` inside them cannot be the delimiter), the port at a trailing `:digits`,
 * and the DNS root's trailing dot goes because `chefsarah.test.` names the same
 * host as `chefsarah.test` while comparing as a different string.
 *
 * Returns null when there is no host to read, which is the "that is not a link"
 * case.
 */
function hostFromLink(withScheme: string): string | null {
  const afterScheme = withScheme.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const authority = afterScheme.split(/[/?#]/)[0];
  const at = authority.lastIndexOf('@');
  const hostAndPort = at === -1 ? authority : authority.slice(at + 1);
  const host = hostAndPort.replace(/:\d*$/, '').toLowerCase().replace(/\.+$/, '');
  return host || null;
}

/**
 * Is this link plausible for the box it was typed into?
 *
 * The client half of `normalizePlatformUrl`: the same rejections, in the same
 * words, so a typo costs a keystroke instead of a round trip. It deliberately
 * does *not* return a normalised URL. The web card predicts what the server will
 * store and rewrites its inputs with the prediction; here the saved links are
 * re-read from `GET /api/creator/me` instead, so what a creator ends up looking
 * at is what is actually stored rather than this file's guess at it.
 */
export function checkPlatformLink(source: PlatformSource, raw: string): LinkCheck {
  const input = (raw ?? '').trim();
  // A blank box is a link nobody typed, which is how a link is cleared. It is
  // never an error — and on the polled source it is the clear that pauses the
  // import, which is the server's decision to make and report, not this one's.
  if (!input) return { ok: true };

  if (input.length > MAX_LINK_CHARS) {
    return {
      ok: false,
      error: `That link is ${input.length} characters long; the limit is ${MAX_LINK_CHARS}. Example: ${EXAMPLES[source]}`,
    };
  }

  // A bare `chefsarah.com` is what most people type, so a missing scheme is
  // filled in rather than rejected. A scheme that *is* present has to be a real
  // one: prefixing `https://` onto `mailto:sarah@x.com` produces a link that
  // parses cleanly and points somewhere else entirely. The negative lookahead
  // keeps `chefsarah.com:8080` out of it — a colon followed by digits is a port.
  const scheme = /^([a-z][a-z0-9+.-]*):(?![0-9])/i.exec(input)?.[1]?.toLowerCase();
  if (scheme && scheme !== 'http' && scheme !== 'https') {
    return { ok: false, error: `Links must start with http:// or https://. Example: ${EXAMPLES[source]}` };
  }
  const withScheme = scheme ? input : `https://${input}`;

  const host = hostFromLink(withScheme);
  if (!host) return { ok: false, error: `That does not look like a link. Example: ${EXAMPLES[source]}` };

  // No dot means `localhost` or an intranet name; a bare IP is never a creator's
  // published home. Both are refused at fetch time too — this is the early, and
  // legible, rejection.
  if (!host.includes('.') || /^\d+(\.\d+)*$/.test(host) || host.includes('[')) {
    return { ok: false, error: `"${host}" is not a public website. Example: ${EXAMPLES[source]}` };
  }

  const expected = PLATFORM_HOSTS[source];
  if (expected) {
    if (!expected.test(host)) {
      return { ok: false, error: `That link is not on ${SOURCE_LABELS[source]}. Example: ${EXAMPLES[source]}` };
    }
    return { ok: true };
  }

  // The website box specifically: catch a social link pasted into it. "Website"
  // is the only source we can poll off a plain fetch, and a wrong entry there is
  // the one that wastes an operator's viability check.
  for (const other of PLATFORM_SOURCES) {
    const pattern = PLATFORM_HOSTS[other];
    if (pattern && pattern.test(host)) {
      return {
        ok: false,
        error: `That is a link to ${SOURCE_LABELS[other]}. Put it in the ${SOURCE_LABELS[other]} box. The website field is for your own site.`,
      };
    }
  }

  return { ok: true };
}

export function isPlatformSource(value: unknown): value is PlatformSource {
  return typeof value === 'string' && (PLATFORM_SOURCES as readonly string[]).includes(value);
}

/**
 * The source Mealio actually polls, when it is polling at all.
 *
 * Both halves are required. `primary_source` names which of the four would be
 * read and `import_opt_in` says whether anything is being read at all, so a
 * creator whose source is set but whose import is off is not being polled and
 * must not be told they are. `none` is the off switch on the first of those.
 */
export function polledSource(creator: {
  primarySource?: string | null;
  importOptIn?: boolean | null;
}): PlatformSource | null {
  if (creator.importOptIn !== true) return null;
  const source = creator.primarySource;
  if (!source || source === 'none' || !isPlatformSource(source)) return null;
  return source;
}
