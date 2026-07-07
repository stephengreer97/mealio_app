import * as SecureStore from 'expo-secure-store';
import { User } from '../types';

const KEYS = {
  ACCESS_TOKEN: 'mealio_access_token',
  REFRESH_TOKEN: 'mealio_refresh_token',
  USER: 'mealio_user',
};

export async function getAccessToken(): Promise<string | null> {
  return SecureStore.getItemAsync(KEYS.ACCESS_TOKEN);
}

export async function getRefreshToken(): Promise<string | null> {
  return SecureStore.getItemAsync(KEYS.REFRESH_TOKEN);
}

export async function getUser(): Promise<User | null> {
  const raw = await SecureStore.getItemAsync(KEYS.USER);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
}

export async function save(accessToken: string, refreshToken: string | undefined | null, user?: User | null): Promise<void> {
  const ops: Promise<void>[] = [
    SecureStore.setItemAsync(KEYS.ACCESS_TOKEN, accessToken),
  ];
  // Tolerate a missing user (e.g. /renew that only returns a token) — keep the
  // already-stored user rather than writing "undefined"/null over it.
  if (user) {
    ops.push(SecureStore.setItemAsync(KEYS.USER, JSON.stringify(user)));
  }
  if (refreshToken) {
    ops.push(SecureStore.setItemAsync(KEYS.REFRESH_TOKEN, refreshToken));
  }
  await Promise.all(ops);
}

export async function clear(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(KEYS.ACCESS_TOKEN),
    SecureStore.deleteItemAsync(KEYS.REFRESH_TOKEN),
    SecureStore.deleteItemAsync(KEYS.USER),
  ]);
}
