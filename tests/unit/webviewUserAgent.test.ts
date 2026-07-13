import {
  androidReleaseFromApiLevel,
  buildAndroidUA,
  buildIosUA,
  ANDROID_CHROME_MAJOR,
} from '../../src/lib/webview-user-agent-build';

describe('androidReleaseFromApiLevel', () => {
  it('maps known API levels to their Android release', () => {
    expect(androidReleaseFromApiLevel(36)).toBe('16');
    expect(androidReleaseFromApiLevel(35)).toBe('15');
    expect(androidReleaseFromApiLevel(34)).toBe('14');
    expect(androidReleaseFromApiLevel(33)).toBe('13');
    expect(androidReleaseFromApiLevel(30)).toBe('11');
    expect(androidReleaseFromApiLevel(29)).toBe('10');
  });

  it('maps both API 31 and 32 to Android 12', () => {
    expect(androidReleaseFromApiLevel(31)).toBe('12');
    expect(androidReleaseFromApiLevel(32)).toBe('12');
  });

  it('extends the (level - 20) rule to unmapped future API levels', () => {
    expect(androidReleaseFromApiLevel(37)).toBe('17');
    expect(androidReleaseFromApiLevel(40)).toBe('20');
  });

  it('floors API levels older than supported to the oldest known release', () => {
    expect(androidReleaseFromApiLevel(21)).toBe('7');
  });
});

describe('buildAndroidUA', () => {
  it('embeds the dynamic Android release and the Chrome constant', () => {
    const ua = buildAndroidUA(33);
    expect(ua).toMatch(/^Mozilla\/5\.0 \(Linux; Android 13; Pixel 9\)/);
    expect(ua).toContain(`Chrome/${ANDROID_CHROME_MAJOR}.0.0.0`);
    expect(ua.endsWith('Mobile Safari/537.36')).toBe(true);
  });

  it('reflects different device OS versions', () => {
    expect(buildAndroidUA(29)).toContain('Android 10;');
    expect(buildAndroidUA(36)).toContain('Android 16;');
  });

  it('allows a Chrome major override', () => {
    expect(buildAndroidUA(36, 140)).toContain('Chrome/140.0.0.0');
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
