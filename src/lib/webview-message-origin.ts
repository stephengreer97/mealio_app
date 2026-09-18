/**
 * Did this WebView message come from the store the sheet is locked to?
 *
 * The cart sheet's WebView can be navigated off the store's domain (a link on
 * the page, a redirect, an ad) and the message bridge stays attached wherever
 * it goes. onMessage used to trust every message regardless of which page sent
 * it, so any site the WebView landed on could post SEARCH_RESULT, NET_ADD_DONE
 * or a session answer and steer a run.
 *
 * WHAT COUNTS AS THE STORE is built from config the store already declares,
 * never typed out here: its `domain` and the hosts of its storeUrl, railUrl,
 * loginUrl and cartUrl, each widened to its registrable domain (the last two
 * labels) so login and SSO subdomains of the store itself pass. That is how
 * H-E-B's sign-in on accounts.heb.com keeps working, and how an Albertsons
 * banner whose storefront host differs from its configured domain still does.
 * None of the configured stores sits under a multi-part public suffix, so two
 * labels is the registrable domain for all of them.
 *
 * ALLOWED WITHOUT A HOST:
 *   - no url at all: messages the native rail drivers post into the same
 *     handler (postFromNative) carry none, and are this process's own.
 *   - a non-http(s) page such as about:blank, which the sheet parks on and
 *     injects into itself. onShouldStartLoadWithRequest already refuses to
 *     navigate anywhere but http, https and about:.
 */

export type StoreHosts = {
  domain: string;
  storeUrl?: string | null;
  railUrl?: string | null;
  loginUrl?: string | null;
  cartUrl?: string | null;
};

function hostOf(url: string): string | null {
  const m = /^https?:\/\/([^/?#]+)/i.exec(url);
  if (!m) return null;
  // Drop any userinfo and port.
  const hostPort = m[1].slice(m[1].lastIndexOf('@') + 1);
  return hostPort.replace(/:\d+$/, '').toLowerCase();
}

function registrable(host: string): string {
  const labels = host.split('.').filter(Boolean);
  return labels.slice(-2).join('.');
}

export function allowedStoreDomains(store: StoreHosts): string[] {
  const out = new Set<string>();
  if (store.domain) out.add(registrable(store.domain.toLowerCase()));
  for (const u of [store.storeUrl, store.railUrl, store.loginUrl, store.cartUrl]) {
    const h = u ? hostOf(u) : null;
    if (h) out.add(registrable(h));
  }
  return [...out].filter(Boolean);
}

export function isMessageFromStore(
  url: string | null | undefined,
  store: StoreHosts | null | undefined,
): boolean {
  if (!url) return true;
  if (!/^https?:/i.test(url)) return true;
  if (!store) return false;
  const host = hostOf(url);
  if (!host) return false;
  return allowedStoreDomains(store).some((d) => host === d || host.endsWith(`.${d}`));
}
