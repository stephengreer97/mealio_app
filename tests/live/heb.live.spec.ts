// Live H-E-B test.
//
// CHECK_LOGIN_SCRIPT auto-generated tests run before/after login/logout.
// No store-specific extra tests yet — add to `extraTests` as needed.

import { getStoreScripts } from '../../src/lib/webview-scripts';
import { buildLiveSuite } from './helpers/build-live-suite';
import { loginHeb } from './helpers/login-heb';
import { logoutHeb } from './helpers/logout-heb';

buildLiveSuite({
  storeName: 'HEB',
  credsKey: 'heb',
  homepageUrl: 'https://www.heb.com',
  scripts: getStoreScripts('heb')!,
  login: loginHeb,
  logout: logoutHeb,
  // clearCart: not yet implemented; tests in this suite don't add to cart.
});
