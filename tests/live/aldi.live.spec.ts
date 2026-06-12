// Live ALDI test.

import { getStoreScripts } from '../../src/lib/webview-scripts';
import { buildLiveSuite } from './helpers/build-live-suite';
import { loginAldi } from './helpers/login-aldi';
import { logoutAldi } from './helpers/logout-aldi';

buildLiveSuite({
  storeName: 'ALDI',
  credsKey: 'aldi',
  homepageUrl: 'https://www.aldi.us',
  scripts: getStoreScripts('aldi')!,
  login: loginAldi,
  logout: logoutAldi,
});
