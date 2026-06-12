// Live Amazon Fresh test.

import { getStoreScripts } from '../../src/lib/webview-scripts';
import { buildLiveSuite } from './helpers/build-live-suite';
import { loginAmazon } from './helpers/login-amazon';
import { logoutAmazon } from './helpers/logout-amazon';

buildLiveSuite({
  storeName: 'Amazon Fresh',
  credsKey: 'amazon',
  homepageUrl: 'https://www.amazon.com/fresh',
  scripts: getStoreScripts('amazon')!,
  login: loginAmazon,
  logout: logoutAmazon,
});
