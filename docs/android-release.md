# Android / Google Play release runbook

How to get Mealio onto the Google Play Store. iOS is already shipping; this
covers the Android-specific setup. Package name: `co.mealio.app`.

## What the repo already handles

- `app.json` → `android` block: package, adaptive icon (with monochrome /
  themed icon), `mealio.co/meal` deep links, no sensitive permissions.
- `eas.json` → `build.production` builds an **AAB** (Play's required format)
  with `autoIncrement` + `appVersionSource: remote`, so EAS owns the
  `versionCode` and bumps it every build. You never edit it by hand.
- `eas.json` → `submit.production.android` points `eas submit` at the Play
  `production` track using `./google-play-service-account.json`.

Build the artifact:

```bash
eas build --platform android --profile production
```

Submit it (only after the manual prerequisites below):

```bash
eas submit --platform android --profile production --latest
```

## Manual prerequisites (cannot be automated)

These live in Google consoles, not the repo. Do them in order.

### 1. Create the app in Play Console
Play Console → **Create app** → name "Mealio", app (not game), free, accept
declarations. The package `co.mealio.app` gets locked in on the first upload.

### 2. Google Play service-account key (for `eas submit`)
1. Play Console → **Setup → API access** → link a Google Cloud project.
2. In Google Cloud, create a service account; in Play Console grant it
   **Release** permissions (Admin is simplest to start).
3. Download the JSON key, save it to the repo root as
   `google-play-service-account.json` (gitignored — never commit it).

### 3. Register the signing SHA-1 for Google Sign-In  ⚠️
Login uses `expo-auth-session` with a native **Android** OAuth client. Google
validates the calling app by package name + signing-cert SHA-1, so without the
right fingerprints **"Sign in with Google" silently fails in the released
build**. After the first AAB is uploaded:
- Get the **Play App Signing** SHA-1 from Play Console → Setup → App signing.
- Get the **EAS upload keystore** SHA-1 from `eas credentials`
  (Android → production).
- Add **both** to the Android OAuth client in Google Cloud → Credentials, on
  the client matching `EXPO_PUBLIC_GOOGLE_CLIENT_ID_ANDROID`.

### 4. Play Billing + RevenueCat (the paid "Full Access" upgrade)  ⚠️
Currently **not started** — Android purchases will fail until this is done.
Ordering trap: you cannot create in-app products until an AAB with the billing
permission has been uploaded to a track, so do step 5 first.
1. Play Console → **Monetize → Subscriptions** → create the product(s) to
   match the iOS offering.
2. RevenueCat → add the Google Play app, upload a Play service-account
   credential with billing access, map the products into the existing
   offering/entitlement, confirm the Android API key matches
   `EXPO_PUBLIC_REVENUECAT_ANDROID_KEY`.
3. Test a purchase with a Play **license tester** account.

### 5. First upload + store listing
- Run the `eas build` then `eas submit` above to push the first AAB.
- Complete the **store listing** (descriptions, screenshots, feature graphic),
  **content rating** questionnaire, **Data safety** form, **target audience**,
  and the privacy policy URL (`https://mealio.co/privacy`).

## ⚠️ Production-track restriction for new accounts
If the Play developer account is an **individual** account created after
Nov 2023, Google requires **closed testing with 12+ testers for 14 continuous
days**, then an approved application for production access, before the
Production track is available. If that applies, temporarily set
`submit.production.android.track` to `internal` (or `closed`) in `eas.json`,
run testing, then switch back to `production`.
