import * as WebBrowser from 'expo-web-browser';
import { creators as creatorsApi } from './api';
import type { ConnectedPlatform } from '../types';
import { CREATOR_CONNECT_REDIRECT, readConnectRedirect } from './creatorConnectUrl';

// ─────────────────────────────────────────────────────────────────────────────
// Connecting YouTube, Instagram or TikTok from inside the app.
//
//   1. POST /api/creator/<p>/connect {client: 'app'}      → { url }
//   2. openAuthSessionAsync(url, 'mealio://creator/connect')
//        The platform's consent screen runs in the system browser (Google
//        refuses its screen in an embedded WebView), and the server's callback
//        sends the creator back to the redirect with a one-time code.
//   3. POST /api/creator/<p>/complete {code, state}       → connected, or a
//        sentence saying why not
//
// Closing the browser is a cancel and says nothing alarming. A failure says
// the server's sentence when there is one, and otherwise the same sentence the
// web portal shows for that reason code.
// ─────────────────────────────────────────────────────────────────────────────

export const PLATFORM_LABELS: Record<ConnectedPlatform, string> = {
  youtube: 'YouTube',
  instagram: 'Instagram',
  tiktok: 'TikTok',
};

/** The name of the screen the creator was on, for the cancel sentence. */
const CONSENT_SCREEN: Record<ConnectedPlatform, string> = {
  youtube: 'Google',
  instagram: 'Instagram',
  tiktok: 'TikTok',
};

/**
 * What a failed attempt says, keyed by the callback's reason code.
 *
 * A mirror of the server's `lib/connect-copy.ts` (`connectFailureCopy`), which
 * the web cards and `POST /complete` read. The redirect never carries a
 * sentence, only a code, so this is where the words for a redirect-level
 * failure come from; `/complete` answers with its own `message`, which wins.
 * An unknown code falls through to the generic line.
 */
const SOCIAL_FAILURE_COPY: Record<string, (label: string) => string> = {
  expired: () => 'That connection attempt has expired. Start again from this page.',
  unverified: () => 'That connection could not be verified. Start again from this page.',
  'no-code': (label) => `${label} sent you back without an authorization code. Try connecting again.`,
  exchange: (label) => `${label} would not complete that connection. Try connecting again.`,
  unavailable: (label) =>
    `${label} would not connect that account. That usually means ${label} declined it rather than you ` +
    'cancelling: a personal account it will not grant access to, or a permission that was turned down. ' +
    `Try again, and if it keeps happening tell us which account and we will look at what ${label} sent back.`,
  scope: () =>
    'That connection came back without permission to read your posts, so there would be nothing to import. ' +
    'Connect again and leave the permission ticked.',
  account: (label) =>
    `We could not use that ${label} account. If it is a personal Instagram account, switch it to Professional ` +
    '(Business or Creator) in the Instagram app and try again.',
  store: () => 'We could not store that connection. Try again.',
};

const YOUTUBE_FAILURE_COPY: Record<string, string> = {
  expired: 'That connection attempt has expired. Start again from this page.',
  unverified: 'That connection could not be verified. Start again from this page.',
  'no-code': 'Google sent you back without an authorization code. Try connecting again.',
  exchange: 'Google would not complete that connection. Try connecting again.',
  account: 'We could not read a channel from that Google account. Make sure it has a YouTube channel, then try again.',
  store: 'We could not store that connection. Try again.',
  'consent-write':
    'Your channel is connected, but we could not save your choice about editing descriptions. It is off. Set it ' +
    'from the card below.',
  'consent-withdraw':
    'We could not record that you no longer want Mealio editing your descriptions, so nothing was changed. Try again.',
};

export const GENERIC_CONNECT_FAILURE = 'That connection did not complete.';

export function failureCopy(platform: ConnectedPlatform, reason: string | null | undefined): string {
  if (!reason) return GENERIC_CONNECT_FAILURE;
  if (platform === 'youtube') {
    return Object.prototype.hasOwnProperty.call(YOUTUBE_FAILURE_COPY, reason)
      ? YOUTUBE_FAILURE_COPY[reason]
      : GENERIC_CONNECT_FAILURE;
  }
  return Object.prototype.hasOwnProperty.call(SOCIAL_FAILURE_COPY, reason)
    ? SOCIAL_FAILURE_COPY[reason](PLATFORM_LABELS[platform])
    : GENERIC_CONNECT_FAILURE;
}

/** The quiet sentence for a creator who said no on the platform's own screen. */
export function cancelledCopy(platform: ConnectedPlatform): string {
  return `You cancelled on ${CONSENT_SCREEN[platform]}’s screen. Nothing was connected.`;
}

export type ConnectOutcome =
  /** The grant is stored. Re-read the status. */
  | { kind: 'connected' }
  /** Closed the browser. Say nothing. */
  | { kind: 'dismissed' }
  /** Declined on the platform's screen. Say so, quietly. */
  | { kind: 'cancelled'; message: string }
  /** Anything else, with the sentence to show. */
  | { kind: 'failed'; message: string };

type OpenSession = (url: string, redirect: string) => Promise<WebBrowser.WebBrowserAuthSessionResult>;

export async function connectPlatform(
  platform: ConnectedPlatform,
  extra: Record<string, unknown> = {},
  // Injectable for tests; production uses the system browser session.
  openSession: OpenSession = (url, redirect) => WebBrowser.openAuthSessionAsync(url, redirect),
): Promise<ConnectOutcome> {
  const label = PLATFORM_LABELS[platform];

  let url: string;
  try {
    const started = await creatorsApi.connections.start(platform, extra);
    if (!started?.url) return { kind: 'failed', message: `Could not start the ${label} connection.` };
    url = started.url;
  } catch (err: any) {
    return { kind: 'failed', message: err?.message || `Could not start the ${label} connection.` };
  }

  let result: WebBrowser.WebBrowserAuthSessionResult;
  try {
    result = await openSession(url, CREATOR_CONNECT_REDIRECT);
  } catch {
    return { kind: 'failed', message: `Could not open ${CONSENT_SCREEN[platform]}. Try again.` };
  }

  if (result.type !== 'success' || !('url' in result) || !result.url) {
    // `cancel` (iOS, Android) and `dismiss` both mean the creator closed the
    // browser. Nothing happened and nothing needs saying.
    return { kind: 'dismissed' };
  }

  const redirect = readConnectRedirect(result.url);
  if (redirect.kind === 'cancelled') return { kind: 'cancelled', message: cancelledCopy(platform) };
  if (redirect.kind === 'failed') return { kind: 'failed', message: failureCopy(platform, redirect.reason) };

  try {
    const done = await creatorsApi.connections.complete(platform, redirect.code, redirect.state);
    if (done?.ok === true) return { kind: 'connected' };
    if (done?.outcome === 'cancelled') {
      return { kind: 'cancelled', message: done.message || cancelledCopy(platform) };
    }
    return { kind: 'failed', message: done?.message || failureCopy(platform, done?.reason ?? null) };
  } catch (err: any) {
    // 403 (a state that does not verify) still carries a sentence and a code;
    // 400/401 carry only `error`.
    const body = err?.body;
    return {
      kind: 'failed',
      message: body?.message || body?.error || failureCopy(platform, body?.reason ?? null),
    };
  }
}
