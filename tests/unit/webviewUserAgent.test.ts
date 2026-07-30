import {
  buildAndroidUA,
  buildIosUA,
  ANDROID_CHROME_MAJOR,
} from '../../src/lib/webview-user-agent-build';

// Chrome's UA reduction freezes the device-identifying parts of the Android UA to
// the literals "Android 10" and "K" on EVERY device (per Chrome's docs), so the UA
// is byte-identical everywhere and carries no device identity. The real model /
// OS version travel in the high-entropy client hints, which the native
// react-native-webview patch fills in from android.os.Build.
describe('buildAndroidUA', () => {
  it('emits the frozen reduced-UA device identity, not the real device', () => {
    const ua = buildAndroidUA(145);
    expect(ua).toBe(
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/145.0.0.0 Mobile Safari/537.36',
    );
  });

  it('never leaks a real device model or OS version into the UA', () => {
    const ua = buildAndroidUA(145);
    expect(ua).not.toMatch(/Pixel|Galaxy|SM-|sdk_gphone|Android 1[1-9]|Android 2\d/);
  });

  it('is identical across devices (no per-device input)', () => {
    expect(buildAndroidUA(145)).toBe(buildAndroidUA(145));
  });

  it('defaults to the maintained Chrome major fallback', () => {
    expect(buildAndroidUA()).toContain(`Chrome/${ANDROID_CHROME_MAJOR}.0.0.0`);
  });

  it('uses the runtime-detected Chrome major when given', () => {
    expect(buildAndroidUA(140)).toContain('Chrome/140.0.0.0');
    expect(buildAndroidUA(999)).toContain('Chrome/999.0.0.0');
  });

  it('falls back on a nonsense Chrome major instead of emitting garbage', () => {
    expect(buildAndroidUA(0)).toContain(`Chrome/${ANDROID_CHROME_MAJOR}.0.0.0`);
    expect(buildAndroidUA(NaN)).toContain(`Chrome/${ANDROID_CHROME_MAJOR}.0.0.0`);
  });

  it('ends with the real Chrome mobile suffix', () => {
    expect(buildAndroidUA(145).endsWith('Mobile Safari/537.36')).toBe(true);
  });
});

describe('buildIosUA', () => {
  it('converts dotted iOS versions to the underscore CPU form', () => {
    const ua = buildIosUA('26.1');
    expect(ua).toContain('CPU iPhone OS 26_1 like Mac OS X');
    expect(ua).toContain('Version/26.1 ');
    expect(ua).toContain('Safari/604.1');
  });

  it('trims a patch version to major.minor (matches real Safari)', () => {
    const ua = buildIosUA('17.5.1');
    expect(ua).toContain('CPU iPhone OS 17_5 like Mac OS X');
    expect(ua).toContain('Version/17.5 ');
    expect(ua).not.toContain('17_5_1');
    expect(ua).not.toContain('17.5.1');
  });

  it('pads a bare major version to major.minor', () => {
    const ua = buildIosUA('18');
    expect(ua).toContain('CPU iPhone OS 18_0 like Mac OS X');
    expect(ua).toContain('Version/18.0 ');
  });
});
