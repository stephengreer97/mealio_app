// Live Albertsons-family test (default member: ACME).
//
// To test a different family member (Safeway, Vons, Jewel-Osco, Pavilions,
// etc), set the `storeId` on your creds entry and update homepageUrl below.

import { getStoreScripts } from '../../src/lib/webview-scripts';
import { buildLiveSuite } from './helpers/build-live-suite';
import { loginAlbertsons } from './helpers/login-albertsons';
import { logoutAlbertsons } from './helpers/logout-albertsons';

const HOME = 'https://www.acmemarkets.com';

buildLiveSuite({
  storeName: 'Albertsons (ACME)',
  credsKey: 'albertsons',
  homepageUrl: HOME,
  scripts: getStoreScripts('acme')!,
  login: (page, creds, opts) => loginAlbertsons(page, creds, HOME, opts),
  logout: (page) => logoutAlbertsons(page, HOME),
});
