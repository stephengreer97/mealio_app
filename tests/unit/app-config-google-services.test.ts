// google-services.json MUST NOT BE IN THE REPOSITORY.
//
// GitHub's secret scanner flagged the Android API key inside it, on a PUBLIC
// repo, and it was right to. Google documents that key as safe to embed -- it
// ships in every APK and anyone can extract it -- but "safe to embed" and
// "belongs in a public repository" are different claims, and a recurring alert
// nobody can action is how a real one comes to be ignored.
//
// Two properties, and the first is the one that would silently rot: the file
// has to stay untracked, and the build has to still find it.
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

const ROOT = path.resolve(__dirname, '../..');

describe('google-services.json stays out of git', () => {
  it('is not tracked', () => {
    const tracked = execFileSync('git', ['ls-files', 'google-services.json'], {
      cwd: ROOT, encoding: 'utf8',
    }).trim();
    expect(tracked).toBe('');
  });

  it('is ignored, so `git add -A` cannot put it back by accident', () => {
    // The failure this prevents is mundane and entirely likely: someone runs
    // `git add -A` after re-downloading the file and re-publishes the key.
    const ignored = execFileSync('git', ['check-ignore', 'google-services.json'], {
      cwd: ROOT, encoding: 'utf8',
    }).trim();
    expect(ignored).toBe('google-services.json');
  });

  it('keeps the SECRET one ignored too, which is a different file entirely', () => {
    // The FCM v1 service-account key can push to every device we hold a token
    // for. Firebase names it with a generated suffix, so the pattern is the
    // guard rather than any one filename.
    const ignored = execFileSync(
      'git', ['check-ignore', 'mealio-app-firebase-adminsdk-ab12c-3456789.json'],
      { cwd: ROOT, encoding: 'utf8' },
    ).trim();
    expect(ignored).toContain('firebase-adminsdk');
  });
});

describe('the build still finds it', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const appConfig = require(path.join(ROOT, 'app.config.js'));
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8')).expo;
  const resolve = (env?: string) => {
    const previous = process.env.GOOGLE_SERVICES_JSON;
    if (env === undefined) delete process.env.GOOGLE_SERVICES_JSON;
    else process.env.GOOGLE_SERVICES_JSON = env;
    try {
      return appConfig({ config: base }).android.googleServicesFile;
    } finally {
      if (previous === undefined) delete process.env.GOOGLE_SERVICES_JSON;
      else process.env.GOOGLE_SERVICES_JSON = previous;
    }
  };

  it('uses the EAS file secret when there is one', () => {
    expect(resolve('/tmp/eas-abc/google-services.json')).toBe('/tmp/eas-abc/google-services.json');
  });

  it('falls back to the local file for a build off this machine', () => {
    expect(resolve(undefined)).toBe('./google-services.json');
  });

  it('treats an EMPTY secret as absent rather than as a path', () => {
    // A misconfigured secret resolving to '' would otherwise build an app with
    // no FCM config at all: a build that succeeds and a handset that still
    // cannot get a token, which is the exact failure this whole thread is about.
    expect(resolve('   ')).toBe('./google-services.json');
  });

  it('changes nothing else about the config', () => {
    const merged = appConfig({ config: base });
    expect(merged.android.package).toBe(base.android.package);
    expect(merged.ios?.bundleIdentifier).toBe(base.ios?.bundleIdentifier);
    expect(merged.plugins).toEqual(base.plugins);
    expect(merged.extra?.eas?.projectId).toBe(base.extra?.eas?.projectId);
  });
});
