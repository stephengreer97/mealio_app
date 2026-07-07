import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import * as SecureStore from 'expo-secure-store';
import { User } from '../types';
import * as tokenStorage from '../lib/tokenStorage';
import { auth, creators } from '../lib/api';
import { initPurchases, identifyUser, resetUser } from '../lib/purchases';

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

  useEffect(() => {
    initPurchases();
    initAuth();
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
    try {
      await auth.logout();
    } catch {}
    await tokenStorage.clear();
    await resetUser();
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
