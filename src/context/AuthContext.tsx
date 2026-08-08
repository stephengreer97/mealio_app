import React, { createContext, useContext, useEffect, useState, useRef, ReactNode } from 'react';
import { AppState, Platform } from 'react-native';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { User } from '../types';
import * as tokenStorage from '../lib/tokenStorage';
import { auth, creators, usage } from '../lib/api';
import { initPurchases, identifyUser, resetUser } from '../lib/purchases';
import { unregisterDevice } from '../lib/push';
import { clearSessionLogs } from '../lib/logBuffer';
import { clearLastAutomationRun } from '../lib/lastAutomationRun';

interface AuthContextValue {
  user: User | null;
  isLoading: boolean;
  isCreator: boolean;
  isAdmin: boolean;
  login: (email: string, password: string) => Promise<any>;
  loginWithToken: (accessToken: string) => Promise<void>;
  logout: () => Promise<void>;
  verify2FA: (twoFactorToken: string, code: string) => Promise<any>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isCreator, setIsCreator] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Usage analytics: session-level "open" logging (best-effort).
  const lastOpenLoggedAt = useRef(0);
  const userRef = useRef<User | null>(null);
  userRef.current = user;

  function recordOpen() {
    lastOpenLoggedAt.current = Date.now();
    usage.logOpen({ source: 'app', platform: Platform.OS, appVersion: Constants.expoConfig?.version });
  }

  // ── The end of a session ───────────────────────────────────────────────────
  //
  // Everything here is in-memory only and all of it is this account's shopping
  // activity: the console ring buffer deliberately retains product names and
  // cart contents (see lib/logBuffer) and a bug report attaches it, and the last
  // cart run is the key that joins such a report to this account's automation
  // rows. On a shared phone neither may follow the previous person into the next
  // person's report.
  //
  // One function, called from BOTH boundaries — `logout` below and `beginSession`
  // when a different account takes over without one. Deliberately not a second
  // copy: MEAL-146 exists precisely because the account boundary and the
  // sign-out boundary had drifted apart, and a copy is how they drift again.
  function endSessionDiagnostics() {
    clearSessionLogs();
    clearLastAutomationRun();
  }

  /**
   * Install `nextUser` as the signed-in user.
   *
   * EVERY path into an authenticated session goes through here — password login,
   * 2FA, the email-verification / OAuth token, the launch-time restore, and
   * refreshUser — so the account boundary is enforced in one place instead of at
   * each of them. `loginWithToken` is the path MEAL-146 was filed against
   * (RootNavigator calls it from an app-wide deep link listener with no
   * signed-in check), but it is not the only one worth covering, and the next
   * one added should not have to know this rule exists.
   *
   * The teardown runs BEFORE setUser, in the same order logout does it, and for
   * the same reason: the instant `user` becomes B, B's session starts — the
   * creator check, the RevenueCat identify, every screen keyed on `user?.id`.
   * Clearing after that point would be clearing B's fresh state instead of A's
   * stale state.
   *
   * Keyed on the id, never on the object: a token renewal or a profile refresh
   * hands down a new User object for the SAME person, and tearing their session
   * down for that would be a new bug of the same family.
   */
  function beginSession(nextUser: User) {
    const previous = userRef.current;
    if (previous && previous.id !== nextUser.id) {
      endSessionDiagnostics();
      // As at logout. Otherwise A's creator status decides what B's tab bar
      // shows for the round trip checkCreatorStatus takes to answer for B.
      setIsCreator(false);
    }
    // Kept in step here rather than waiting for the next render, so that a
    // second call landing before React re-renders compares against the account
    // this one just installed.
    userRef.current = nextUser;
    setUser(nextUser);
  }

  useEffect(() => {
    initPurchases();
    initAuth();
  }, []);

  // Log an open when the app returns to the foreground after being idle a while
  // (a new session), for signed-in users. Launch opens are logged in initAuth.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || !userRef.current) return;
      if (Date.now() - lastOpenLoggedAt.current < 30 * 60 * 1000) return;
      recordOpen();
    });
    return () => sub.remove();
  }, []);

  async function initAuth() {
    try {
      const [accessToken, refreshToken, storedUser] = await Promise.all([
        tokenStorage.getAccessToken(),
        tokenStorage.getRefreshToken(),
        tokenStorage.getUser(),
      ]);

      if (!accessToken || !storedUser) {
        setIsLoading(false);
        return;
      }

      // Verify token is still valid
      try {
        const { user: verifiedUser } = await auth.verify();
        beginSession(verifiedUser);
        recordOpen();
        await Promise.all([checkCreatorStatus(), identifyUser(verifiedUser.id)]);
      } catch {
        // Token expired — try renewing with the current access token
        try {
          const result = await auth.renew(accessToken);
          if (result.accessToken) {
            // Renew may omit the user; fall back to the already-stored one.
            const renewedUser = result.user ?? storedUser;
            await tokenStorage.save(result.accessToken, null, renewedUser);
            beginSession(renewedUser);
            recordOpen();
            await Promise.all([checkCreatorStatus(), identifyUser(renewedUser.id)]);
          } else {
            await tokenStorage.clear();
          }
        } catch {
          await tokenStorage.clear();
        }
      }
    } finally {
      setIsLoading(false);
    }
  }

  async function checkCreatorStatus() {
    try {
      const { creator } = await creators.getMe();
      setIsCreator(!!creator);
    } catch {
      setIsCreator(false);
    }
  }

  async function login(email: string, password: string) {
    const result = await auth.login(email, password);

    if (result.requiresVerification || result.requiresTwoFactor) {
      return result;
    }

    if (result.accessToken) {
      await tokenStorage.save(result.accessToken, null, result.user);
      beginSession(result.user);
      await Promise.all([checkCreatorStatus(), identifyUser(result.user.id)]);
    }

    return result;
  }

  async function loginWithToken(accessToken: string) {
    // Store the token first so auth.verify() can read it
    await SecureStore.setItemAsync('mealio_access_token', accessToken);
    const { user: verifiedUser } = await auth.verify();
    await tokenStorage.save(accessToken, null, verifiedUser);
    beginSession(verifiedUser);
    await Promise.all([checkCreatorStatus(), identifyUser(verifiedUser.id)]);
  }

  async function logout() {
    // Retire this device's push token first: a shared phone must not keep
    // receiving the previous account's notifications, and once the access token
    // is gone the unregister call can no longer authenticate.
    await unregisterDevice().catch(() => {});
    try {
      await auth.logout();
    } catch {}
    try {
      await tokenStorage.clear();
      await resetUser();
    } finally {
      // Drop this account's diagnostics — see endSessionDiagnostics above for
      // what and why. Signing out is one of the two ways this session can end;
      // the other is another account taking over without one, and it runs the
      // same function rather than a copy of it.
      //
      // In a `finally` because tokenStorage.clear() is three bare
      // SecureStore.deleteItemAsync calls in a Promise.all and nothing above
      // catches it: one keychain rejection used to skip both clears. Nothing
      // here can throw (the buffer is an array, the run is a module variable),
      // so it cannot mask the original error.
      endSessionDiagnostics();
    }
    // Kept in step with the state for the same reason beginSession does it: a
    // sign-in landing before React re-renders must see that nobody is here, not
    // the account that just left.
    userRef.current = null;
    setUser(null);
    setIsCreator(false);
  }

  async function verify2FA(twoFactorToken: string, code: string) {
    const result = await auth.verify2FA(twoFactorToken, code);

    if (result.accessToken) {
      await tokenStorage.save(result.accessToken, null, result.user);
      beginSession(result.user);
      await Promise.all([checkCreatorStatus(), identifyUser(result.user.id)]);
    }

    return result;
  }

  async function refreshUser() {
    try {
      const { user: updated } = await auth.verify();
      beginSession(updated);
      const accessToken = await tokenStorage.getAccessToken();
      if (accessToken) {
        await tokenStorage.save(accessToken, null, updated);
      }
    } catch {}
  }

  const isAdmin = !!user?.isAdmin;

  return (
    <AuthContext.Provider value={{ user, isLoading, isCreator, isAdmin, login, loginWithToken, logout, verify2FA, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
