// Which pages may post to the cart sheet. See src/lib/webview-message-origin.ts.

import { isMessageFromStore } from '../../src/lib/webview-message-origin';
import { getStoreScripts } from '../../src/lib/webview-scripts';

const heb = getStoreScripts('heb')!;
const aldi = getStoreScripts('aldi')!;

describe('isMessageFromStore', () => {
  it.each([
    'https://www.heb.com/',
    'https://www.heb.com/robots.txt',
    'https://heb.com/cart',
    // Sign-in lives on a subdomain of the store itself.
    'https://accounts.heb.com/interaction/abc/login',
  ])('accepts the store and its own subdomains: %s', (url) => {
    expect(isMessageFromStore(url, heb)).toBe(true);
  });

  it.each([
    'https://evil.example/',
    // Contains the store's domain, but is not the store. The onLoadEnd
    // substring test would let both of these through.
    'https://heb.com.evil.example/',
    'https://evil.example/?next=https://www.heb.com/',
    'https://notheb.com/',
    // Another store is not this store.
    'https://www.aldi.us/',
  ])('drops any other site: %s', (url) => {
    expect(isMessageFromStore(url, heb)).toBe(false);
  });

  it('accepts an Instacart banner on its own host', () => {
    expect(isMessageFromStore('https://www.aldi.us/store/aldi/storefront', aldi)).toBe(true);
    expect(isMessageFromStore('https://www.instacart.com/', aldi)).toBe(false);
  });

  it('accepts a message with no page: the native drivers post these', () => {
    expect(isMessageFromStore(undefined, heb)).toBe(true);
    expect(isMessageFromStore('', heb)).toBe(true);
  });

  it('accepts about:blank, which the sheet parks on itself', () => {
    expect(isMessageFromStore('about:blank', heb)).toBe(true);
  });

  it('ignores a port and userinfo when reading the host', () => {
    expect(isMessageFromStore('https://www.heb.com:443/x', heb)).toBe(true);
    expect(isMessageFromStore('https://www.heb.com@evil.example/', heb)).toBe(false);
  });
});
