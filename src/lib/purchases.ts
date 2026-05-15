import { Platform } from 'react-native';
import Purchases, { LOG_LEVEL, PurchasesPackage } from 'react-native-purchases';
import Constants from 'expo-constants';

const IOS_KEY     = process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY ?? '';
const ANDROID_KEY = process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_KEY ?? '';

export const ENTITLEMENT_ID = 'full_access';

let configured = false;

export function initPurchases() {
  // Native store not available in Expo Go
  if (Constants.appOwnership === 'expo') return;
  const apiKey = Platform.OS === 'ios' ? IOS_KEY : ANDROID_KEY;
  if (!apiKey) return;
  try {
    if (__DEV__) Purchases.setLogLevel(LOG_LEVEL.DEBUG);
    Purchases.configure({ apiKey });
    configured = true;
  } catch {
    // Silently ignore any configuration errors
  }
}

export async function identifyUser(userId: string) {
  if (!configured) return;
  try {
    await Purchases.logIn(userId);
  } catch {}
}

export async function resetUser() {
  if (!configured) return;
  try {
    await Purchases.logOut();
  } catch {}
}

export async function getOffering(): Promise<PurchasesPackage | null> {
  if (!configured) return null;
  try {
    const offerings = await Purchases.getOfferings();
    return offerings.current?.availablePackages?.[0] ?? null;
  } catch {
    return null;
  }
}

export async function getAllOfferings(): Promise<PurchasesPackage[]> {
  if (!configured) return [];
  try {
    const offerings = await Purchases.getOfferings();
    return offerings.current?.availablePackages ?? [];
  } catch {
    return [];
  }
}

export async function purchasePackage(pkg: PurchasesPackage): Promise<boolean> {
  if (!configured) throw new Error('Purchases not available');
  const { customerInfo } = await Purchases.purchasePackage(pkg);
  return !!customerInfo.entitlements.active[ENTITLEMENT_ID];
}

export async function restorePurchases(): Promise<boolean> {
  if (!configured) throw new Error('Purchases not available');
  const customerInfo = await Purchases.restorePurchases();
  return !!customerInfo.entitlements.active[ENTITLEMENT_ID];
}

export async function checkEntitlement(): Promise<boolean> {
  if (!configured) return false;
  try {
    const customerInfo = await Purchases.getCustomerInfo();
    return !!customerInfo.entitlements.active[ENTITLEMENT_ID];
  } catch {
    return false;
  }
}

/**
 * Returns the store where the active entitlement was purchased:
 * 'app_store' | 'play_store' | 'stripe' | 'promotional' | null
 * Returns null if not configured or no active entitlement.
 */
export async function getActiveSubscriptionStore(): Promise<string | null> {
  if (!configured) return null;
  try {
    const customerInfo = await Purchases.getCustomerInfo();
    return customerInfo.entitlements.active[ENTITLEMENT_ID]?.store ?? null;
  } catch {
    return null;
  }
}
