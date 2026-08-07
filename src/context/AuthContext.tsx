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
        setUser(verifiedUser);
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
            setUser(renewedUser);
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
      setUser(result.user);
      await Promise.all([checkCreatorStatus(), identifyUser(result.user.id)]);
    }

    return result;
  }

  async function loginWithToken(accessToken: string) {
    // Store the token first so auth.verify() can read it
    await SecureStore.setItemAsync('mealio_access_token', accessToken);
    const { user: verifiedUser } = await auth.verify();
    await tokenStorage.save(accessToken, null, verifiedUser);
    setUser(verifiedUser);
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
    await tokenStorage.clear();
    await resetUser();
    // Drop this account's diagnostics. The console ring buffer deliberately
    // keeps product names and cart contents (see lib/logBuffer) and the last
    // cart run is this account's shopping activity; both live in memory only,
    // so both used to survive a sign-out. On a shared phone that meant the
    // previous person's cart getting attached to the next person's bug report,
    // under the next person's verified userId. Same reasoning as the push token
    // above: a shared phone must not carry one account's state into another's.
    clearSessionLogs();
    clearLastAutomationRun();
    setUser(null);
    setIsCreator(false);
  }

  async function verify2FA(twoFactorToken: string, code: string) {
    const result = await auth.verify2FA(twoFactorToken, code);

    if (result.accessToken) {
      await tokenStorage.save(result.accessToken, null, result.user);
      setUser(result.user);
      await Promise.all([checkCreatorStatus(), identifyUser(result.user.id)]);
    }

    return result;
  }

  async function refreshUser() {
    try {
      const { user: updated } = await auth.verify();
      setUser(updated);
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
