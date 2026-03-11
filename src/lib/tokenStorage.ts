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

export async function save(accessToken: string, refreshToken: string | undefined | null, user: User): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(KEYS.ACCESS_TOKEN, accessToken),
    refreshToken
      ? SecureStore.setItemAsync(KEYS.REFRESH_TOKEN, refreshToken)
      : SecureStore.deleteItemAsync(KEYS.REFRESH_TOKEN),
    SecureStore.setItemAsync(KEYS.USER, JSON.stringify(user)),
  ]);
}

export async function clear(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(KEYS.ACCESS_TOKEN),
    SecureStore.deleteItemAsync(KEYS.REFRESH_TOKEN),
    SecureStore.deleteItemAsync(KEYS.USER),
  ]);
}
