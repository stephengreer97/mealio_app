// Live Walmart test.

import { getStoreScripts } from '../../src/lib/webview-scripts';
import { buildLiveSuite } from './helpers/build-live-suite';
import { loginWalmart } from './helpers/login-walmart';
import { logoutWalmart } from './helpers/logout-walmart';

buildLiveSuite({
  storeName: 'Walmart',
  credsKey: 'walmart',
  homepageUrl: 'https://www.walmart.com/grocery',
  scripts: getStoreScripts('walmart')!,
  login: loginWalmart,
  logout: logoutWalmart,
});
