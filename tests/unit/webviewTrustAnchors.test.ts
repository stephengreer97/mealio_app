// Guards on the Android trust anchor added for the Albertsons identity host.
//
// The anchor is load-bearing in an unusual direction: network_security_config
// REPLACES the default anchor set for the whole app, so a missing, empty, or
// malformed certificate here does not degrade to "as before" — it fails closed
// on every TLS connection the app makes. That is why the file's content is
// pinned by fingerprint rather than merely checked for existence.
//
// The fingerprint is the one the device itself carries for this root, read off
// /apex/com.android.conscrypt/cacerts, and the one Chrome trusts. If Sectigo
// ever rotates it, this test failing is the correct outcome: the replacement
// has to be verified by hand, not swapped in silently.

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const ROOT = path.resolve(__dirname, '..', '..');
const PEM = path.join(ROOT, 'assets', 'certs', 'sectigo-public-server-auth-root-r46.pem');

const EXPECTED_SHA256 =
  '7BB647A62AEEAC88BF257AA522D01FFEA395E0AB45C73F93F65654EC38F25A06';

describe('android webview trust anchor', () => {
  it('ships exactly one certificate', () => {
    const pem = fs.readFileSync(PEM, 'utf8');
    expect(pem.match(/-----BEGIN CERTIFICATE-----/g)).toHaveLength(1);
    expect(pem.match(/-----END CERTIFICATE-----/g)).toHaveLength(1);
  });

  it('is the Sectigo root the device and Chrome both trust, by fingerprint', () => {
    const pem = fs.readFileSync(PEM, 'utf8');
    const b64 = pem
      .replace(/-----BEGIN CERTIFICATE-----/, '')
      .replace(/-----END CERTIFICATE-----/, '')
      .replace(/\s+/g, '');
    const der = Buffer.from(b64, 'base64');
    const fp = crypto.createHash('sha256').update(der).digest('hex').toUpperCase();
    expect(fp).toBe(EXPECTED_SHA256);
  });

  it('is a self-signed root that has not expired', () => {
    const pem = fs.readFileSync(PEM, 'utf8');
    const cert = new crypto.X509Certificate(pem);
    expect(cert.subject).toBe(cert.issuer);
    expect(new Date(cert.validTo).getTime()).toBeGreaterThan(Date.now());
  });

  it('is registered as a config plugin, or the anchor never reaches the build', () => {
    const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
    const plugins: unknown[] = app.expo.plugins;
    const names = plugins.map((p) => (Array.isArray(p) ? p[0] : p));
    expect(names).toContain('./plugins/withWebViewTrustAnchors');
  });
});

describe('android network security config', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const plugin = require('../../plugins/withWebViewTrustAnchors');

  it('keeps cleartext OFF for release, as the app behaves today', () => {
    expect(plugin.configXml(false)).toContain('cleartextTrafficPermitted="false"');
  });

  it('keeps cleartext ON for debug — a network security config overrides the debug manifest, and without this every dev build loses Metro', () => {
    expect(plugin.configXml(true)).toContain('cleartextTrafficPermitted="true"');
  });

  it('trusts the system anchors first, then adds ours — never ours alone', () => {
    for (const xml of [plugin.configXml(true), plugin.configXml(false)]) {
      expect(xml).toContain('<certificates src="system" />');
      expect(xml).toContain(`<certificates src="@raw/${plugin.RAW_NAME}" />`);
      expect(xml.indexOf('src="system"')).toBeLessThan(xml.indexOf(plugin.RAW_NAME));
    }
  });
});
