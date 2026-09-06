/**
 * Layered on top of app.json, for one reason: keeping
 * `google-services.json` out of a PUBLIC repository.
 *
 * WHAT HAPPENED. The file was committed on my advice, GitHub's secret scanner
 * flagged the Android API key inside it, and it was right to. Google documents
 * that key as safe to embed -- it ships inside every APK and anyone can extract
 * it -- and that is true, but "true" and "belongs in a public repo" are
 * different claims. A recurring alert nobody can action is how a real one comes
 * to be ignored.
 *
 * HOW IT RESOLVES NOW:
 *   EAS build   `GOOGLE_SERVICES_JSON` is a file-type EAS secret; EAS writes it
 *               to a temp path and puts that path in the env var.
 *   Locally     falls back to ./google-services.json, which is gitignored.
 *
 * app.json stays the source of truth for everything else. This file only
 * overrides the one value that cannot live in version control, so a change to
 * the app config still goes in app.json where everyone looks for it.
 */
module.exports = ({ config }) => ({
  ...config,
  android: {
    ...config.android,
    // The env var when EAS provides it, the local file otherwise. Not `||`:
    // an empty string from a misconfigured secret should fall through to the
    // local path rather than silently building with no FCM config at all.
    googleServicesFile:
      process.env.GOOGLE_SERVICES_JSON?.trim()
      || config.android?.googleServicesFile,
  },
});
