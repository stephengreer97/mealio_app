import React, { useState, useEffect, useCallback } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  FlatList,
  Linking,
  Platform,
  TextInput,
  Modal,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-aware-scroll-view';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Colors, Radius } from '../../constants/colors';
import { resetFirstRun } from '../../lib/firstRun';
import { useStores } from '../../lib/store-catalog/useStores';
import { useAuth } from '../../context/AuthContext';
import { auth as authApi, account as accountApi, creators as creatorsApi, meals as mealsApi, images as imagesApi, payments as paymentsApi, kroger as krogerApi } from '../../lib/api';
import * as tokenStorage from '../../lib/tokenStorage';
import { getPushStatus, enablePush, disablePush, type PushStatus } from '../../lib/push';
import { getAllOfferings, purchasePackage, restorePurchases, getActiveSubscriptionStore, getEntitlementDetails, getManagementURL, onEntitlementChange, ENTITLEMENT_ID, type EntitlementDetails } from '../../lib/purchases';
import Purchases, { type PurchasesPackage } from 'react-native-purchases';
import * as WebBrowser from 'expo-web-browser';
import { Creator, Meal } from '../../types';
import Card from '../../components/ui/Card';
import NotificationSettingsSheet from '../../components/NotificationSettingsSheet';
import Button from '../../components/ui/Button';
import Input from '../../components/ui/Input';
import CookieManager from '@react-native-cookies/cookies';

/** e.g. "Jul 9, 2026" */
function formatExpiry(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function AccountScreen() {
  const { user, isCreator, logout, refreshUser } = useAuth();
  const stores = useStores();
  const [following, setFollowing] = useState<Creator[]>([]);
  const [deletedMeals, setDeletedMeals] = useState<Meal[]>([]);

  // Change password state
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [pwLoading, setPwLoading] = useState(false);
  const [pwError, setPwError] = useState('');

  // Subscription
  const [upgradeLoading, setUpgradeLoading] = useState(false);
  const [storeLogoutLoading, setStoreLogoutLoading] = useState(false);
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);
  const [offerings, setOfferings] = useState<PurchasesPackage[]>([]);
  const [billing, setBilling] = useState<'monthly' | 'annual'>('monthly');
  const [entDetails, setEntDetails] = useState<EntitlementDetails | null>(null);

  // Account deletion
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');

  // Kroger
  const [krogerConnected, setKrogerConnected] = useState(false);
  const [krogerLocations, setKrogerLocations] = useState<Record<string, { locationId: string; locationName: string | null }>>({});
  const [krogerZip, setKrogerZip] = useState('');
  const [krogerLocationsList, setKrogerLocationsList] = useState<Array<{ locationId: string; name: string; chain?: string; storeId: string; address: string }>>([]);
  const [krogerSearching, setKrogerSearching] = useState(false);
  const [krogerConnecting, setKrogerConnecting] = useState(false);

  // Creator photo state
  const [uploading, setUploading] = useState(false);
  const [creatorProfile, setCreatorProfile] = useState<Creator | null>(null);

  // Notifications (MEAL-88)
  const [pushStatus, setPushStatus] = useState<PushStatus | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [notifSettingsOpen, setNotifSettingsOpen] = useState(false);

  useEffect(() => {
    loadFollowing();
    loadDeletedMeals();
    loadKrogerStatus();
    if (isCreator) loadCreatorProfile();
  }, [isCreator]);

  // Load offerings once the tier resolves — keyed on tier so it refreshes if the
  // user/tier arrives after first render (e.g. free plan resolving late).
  useEffect(() => {
    if (user?.tier !== 'paid') loadOffering();
  }, [user?.tier]);

  // Renewal/expiry details for the "Full Access until …" line. Refetch on focus
  // and subscribe to live changes so a cancellation surfaces without a reload.
  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      getEntitlementDetails().then((d) => { if (mounted) setEntDetails(d); });
      const unsubscribe = onEntitlementChange((d) => setEntDetails(d));
      return () => { mounted = false; unsubscribe(); };
    }, [])
  );

  // Re-read on focus rather than once on mount: the only way out of "blocked" is
  // the system Settings app, so the user comes back to this screen having
  // changed the answer somewhere we can't observe.
  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      getPushStatus().then((s) => { if (mounted) setPushStatus(s); });
      return () => { mounted = false; };
    }, [])
  );

  async function handleTogglePush() {
    if (pushStatus === 'blocked') {
      Linking.openSettings();
      return;
    }
    setPushBusy(true);
    try {
      if (pushStatus === 'on') {
        await disablePush();
        setPushStatus('off');
      } else {
        setPushStatus(await enablePush());
      }
    } finally {
      setPushBusy(false);
    }
  }

  async function loadOffering() {
    const pkgs = await getAllOfferings();
    setOfferings(pkgs);
  }

  // Return-from-browser deep link: mealio://kroger/connected
  useEffect(() => {
    const sub = Linking.addEventListener('url', ({ url }) => {
      if (url === 'mealio://kroger/connected') {
        loadKrogerStatus();
      } else if (url === 'mealio://kroger/denied') {
        Alert.alert('Kroger', 'Kroger connection was cancelled.');
      } else if (url === 'mealio://kroger/error') {
        Alert.alert('Kroger', 'Something went wrong connecting to Kroger. Please try again.');
      }
    });
    return () => sub.remove();
  }, []);

  async function loadFollowing() {
    try {
      const data = await creatorsApi.following();
      setFollowing(data);
    } catch {}
  }

  async function loadDeletedMeals() {
    try {
      const data = await mealsApi.listDeleted();
      setDeletedMeals(data);
    } catch {}
  }

  async function loadKrogerStatus() {
    try {
      const data = await krogerApi.status();
      if (data.connected) {
        setKrogerConnected(true);
        setKrogerLocations(data.locations ?? {});
      }
    } catch {}
  }

  async function loadCreatorProfile() {
    try {
      const { creator } = await creatorsApi.getMe();
      setCreatorProfile(creator);
    } catch {}
  }

  async function handleChangePassword() {
    if (!currentPw || !newPw) {
      setPwError('Both fields are required');
      return;
    }
    if (newPw.length < 8) {
      setPwError('New password must be at least 8 characters');
      return;
    }
    setPwLoading(true);
    setPwError('');
    try {
      const res = await accountApi.changePassword(currentPw, newPw);
      // Changing the password revokes all sessions server-side; persist the fresh
      // token the server returned so this device stays signed in.
      if (res?.accessToken) await tokenStorage.save(res.accessToken, null, user);
      setCurrentPw('');
      setNewPw('');
      Alert.alert('Success', 'Password changed successfully');
    } catch (err: any) {
      setPwError(err.message || 'Could not change password');
    } finally {
      setPwLoading(false);
    }
  }

  async function handlePhotoUpload() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
      base64: true,
    });

    if (!result.canceled && result.assets[0].base64) {
      setUploading(true);
      try {
        const dataUrl = `data:image/jpeg;base64,${result.assets[0].base64}`;
        const { url } = await imagesApi.upload(dataUrl);
        await creatorsApi.updateMe({ photoUrl: url });
        await loadCreatorProfile();
        Alert.alert('Success', 'Profile photo updated');
      } catch (err: any) {
        Alert.alert('Error', err.message || 'Could not upload photo');
      } finally {
        setUploading(false);
      }
    }
  }

  async function handleUnfollow(creatorId: string) {
    try {
      await creatorsApi.unfollow(creatorId);
      setFollowing((prev) => prev.filter((c) => c.id !== creatorId));
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Could not unfollow');
    }
  }

  async function handleRestore(mealId: string) {
    try {
      await mealsApi.restore(mealId);
      setDeletedMeals((prev) => prev.filter((m) => m.id !== mealId));
      Alert.alert('Restored', 'Meal has been restored to My Meals');
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Could not restore meal');
    }
  }

  async function handlePermanentDelete(mealId: string, name: string) {
    Alert.alert('Permanently Delete', `Permanently delete "${name}"? This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete Forever',
        style: 'destructive',
        onPress: async () => {
          try {
            await mealsApi.permanentDelete(mealId);
            setDeletedMeals((prev) => prev.filter((m) => m.id !== mealId));
          } catch (err: any) {
            Alert.alert('Error', err.message || 'Could not delete meal');
          }
        },
      },
    ]);
  }

  async function handleKrogerConnect() {
    setKrogerConnecting(true);
    try {
      const { redirectUrl } = await krogerApi.connect();
      // Keep the OAuth round-trip in-app (Custom Tab / ASWebAuthenticationSession).
      // Kroger redirects to our server callback, which bounces the final hop to
      // mealio://kroger/connected|denied|error — the auth session returns it here.
      const result = await WebBrowser.openAuthSessionAsync(redirectUrl, 'mealio://kroger/connected');
      if (result.type === 'success') {
        if (result.url.includes('/connected')) {
          await loadKrogerStatus();
        } else if (result.url.includes('/denied')) {
          Alert.alert('Kroger', 'Kroger connection was cancelled.');
        } else if (result.url.includes('/error')) {
          Alert.alert('Kroger', 'Something went wrong connecting to Kroger. Please try again.');
        }
      }
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Could not connect to Kroger');
    } finally {
      setKrogerConnecting(false);
    }
  }

  async function handleKrogerDisconnect() {
    Alert.alert('Disconnect Kroger', 'Remove your Kroger connection?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disconnect',
        style: 'destructive',
        onPress: async () => {
          try {
            await krogerApi.disconnect();
            setKrogerConnected(false);
            setKrogerLocations({});
            setKrogerLocationsList([]);
          } catch (err: any) {
            Alert.alert('Error', err.message || 'Could not disconnect');
          }
        },
      },
    ]);
  }

  async function handleKrogerSearchStores() {
    if (!krogerZip.trim()) return;
    setKrogerSearching(true);
    setKrogerLocationsList([]);
    try {
      const { locations } = await krogerApi.searchLocations(krogerZip);
      setKrogerLocationsList(locations);
      if (locations.length === 0) Alert.alert('No stores found', 'No Kroger stores found near that ZIP code.');
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Could not search stores');
    } finally {
      setKrogerSearching(false);
    }
  }

  async function handleKrogerSaveLocation(loc: { locationId: string; name: string; storeId: string; address: string }) {
    try {
      await krogerApi.setLocation(loc.locationId, loc.name, loc.storeId);
      setKrogerLocations(prev => ({ ...prev, [loc.storeId]: { locationId: loc.locationId, locationName: loc.name } }));
      setKrogerLocationsList([]);
      setKrogerZip('');
      Alert.alert('Store saved.', '');
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Could not save store');
    }
  }

  async function handleUpgrade() {
    setUpgradeLoading(true);
    try {
      const pkg = selectedPkg;
      if (!pkg) {
        Alert.alert('Unavailable', 'No subscription plans found. Please try again later.');
        return;
      }
      const active = await purchasePackage(pkg);
      if (active) {
        await refreshUser();
        Alert.alert('Welcome to Full Access!', 'Your subscription is now active.');
      } else {
        // Purchase succeeded but the entitlement hasn't propagated yet.
        Alert.alert('Purchase received', 'Activating your subscription… this can take a moment.');
        await refreshUser();
      }
    } catch (err: any) {
      if (!err.userCancelled) {
        Alert.alert('Purchase Failed', err.message || 'Something went wrong. Please try again.');
      }
    } finally {
      setUpgradeLoading(false);
    }
  }

  function handleDeleteAccount() {
    setDeleteConfirmText('');
    setDeleteConfirmVisible(true);
  }

  async function confirmDeleteAccount() {
    if (deleteConfirmText !== 'Delete Account') return;
    setDeleteLoading(true);
    try {
      await accountApi.deleteAccount();
      setDeleteConfirmVisible(false);
      await logout();
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Could not delete account. Please try again.');
    } finally {
      setDeleteLoading(false);
    }
  }

  async function handleRestorePurchases() {
    setRestoreLoading(true);
    try {
      const active = await restorePurchases();
      if (active) {
        await refreshUser();
        Alert.alert('Restored', 'Your subscription has been restored.');
      } else {
        Alert.alert('Nothing to Restore', 'No active subscription found for this account.');
      }
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Could not restore purchases.');
    } finally {
      setRestoreLoading(false);
    }
  }

  async function handleManageSubscription() {
    setPortalLoading(true);
    try {
      // Route based on WHERE the subscription was purchased. A store subscription
      // can only be managed on the platform it was bought on — an App Store sub
      // only from an Apple device, a Play sub only from Android. Calling the
      // native manage UI for the "other" store throws ("this method is not
      // available in the current platform"), so only call it when the store
      // matches this device; otherwise point the user to the right place.
      const store = await getActiveSubscriptionStore();

      const nativeOnThisPlatform =
        (store === 'app_store' && Platform.OS === 'ios') ||
        (store === 'play_store' && Platform.OS === 'android');

      if (nativeOnThisPlatform) {
        if (Platform.OS === 'ios') {
          // iOS 13+: native App Store manage-subscriptions sheet. This method is
          // iOS-only in react-native-purchases (it throws on Android).
          await Purchases.showManageSubscriptions();
        } else {
          // Android: showManageSubscriptions is not available, so open the Play
          // Store subscriptions page. RevenueCat's managementURL is the exact
          // Play deep link; fall back to the generic page filtered to our package.
          const url =
            (await getManagementURL()) ??
            'https://play.google.com/store/account/subscriptions?package=co.mealio.app';
          await Linking.openURL(url);
        }
        // They may have just cancelled — pull fresh renewal/expiry state.
        setEntDetails(await getEntitlementDetails());
      } else if (store === 'app_store') {
        // Purchased on the App Store but viewing from Android — Google Play can't
        // manage Apple subscriptions.
        Alert.alert(
          'Manage on your Apple device',
          'This subscription was purchased through the App Store. To change or cancel it, open Settings → your name → Subscriptions on your iPhone or iPad, or manage it on the web.',
          [
            { text: 'Close', style: 'cancel' },
            {
              text: 'Open on the web',
              onPress: () =>
                WebBrowser.openBrowserAsync('https://apps.apple.com/account/subscriptions'),
            },
          ],
        );
      } else if (store === 'play_store') {
        // Purchased on Google Play but viewing from iOS — the App Store can't
        // manage Play subscriptions.
        Alert.alert(
          'Manage on your Android device',
          'This subscription was purchased through Google Play. To change or cancel it, open the Play Store → Subscriptions on your Android device, or manage it on the web.',
          [
            { text: 'Close', style: 'cancel' },
            {
              text: 'Open on the web',
              onPress: () =>
                WebBrowser.openBrowserAsync('https://play.google.com/store/account/subscriptions'),
            },
          ],
        );
      } else {
        // Stripe subscriber, or subscription not found in RevenueCat (e.g. web-only
        // subscriber). Open the billing portal in an in-app browser sheet instead
        // of handing off to the external browser.
        const { portalUrl } = await paymentsApi.portal();
        if (portalUrl) await WebBrowser.openBrowserAsync(portalUrl);
      }
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Could not load subscription management');
    } finally {
      setPortalLoading(false);
    }
  }

  async function handleLogout() {
    Alert.alert('Sign Out', 'Sign out of this device, or of all devices?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'This device', onPress: logout },
      { text: 'All devices', style: 'destructive', onPress: handleLogoutAll },
    ]);
  }

  async function handleLogoutAll() {
    try { await authApi.logoutAll(); } catch {}
    await logout();
  }

  async function handleStoreLogout() {
    Alert.alert(
      'Log Out of Grocery Stores',
      'This signs you out of every connected grocery store (H-E-B, Albertsons, Walmart, Kroger, etc.). You will need to reconnect Kroger to use it again. Your Mealio account stays signed in.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Log Out',
          style: 'destructive',
          onPress: async () => {
            try {
              setStoreLogoutLoading(true);
              // WebView stores (HEB, Albertsons, Walmart, etc.): clear the cookie
              // jar (incl. HttpOnly store auth cookies). Pass both true/false to
              // cover iOS WKWebView and the shared NSHTTPCookieStorage; the arg is
              // ignored on Android.
              await CookieManager.clearAll(true);
              await CookieManager.clearAll(false);
              // Kroger is API/OAuth, not a WebView cookie — disconnect it
              // server-side too so "all stores" really means all.
              if (krogerConnected) {
                await krogerApi.disconnect();
                setKrogerConnected(false);
                setKrogerLocations({});
                setKrogerLocationsList([]);
              }
              Alert.alert('Signed out', "You've been signed out of all grocery stores.");
            } catch (err: any) {
              Alert.alert('Error', err?.message || 'Could not sign out of grocery stores.');
            } finally {
              setStoreLogoutLoading(false);
            }
          },
        },
      ],
    );
  }

  const selectedPkgType = billing === 'annual' ? 'ANNUAL' : 'MONTHLY';
  const selectedPkg = offerings.find(p => p.packageType === selectedPkgType) ?? offerings[0] ?? null;
  const fallbackPrice = billing === 'annual' ? '$39.99' : '$3.99';

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAwareScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" enableOnAndroid extraScrollHeight={24}>
        <Text style={styles.pageTitle}>Account</Text>

        {/* Account Information */}
        <Card style={styles.card}>
          <Text style={styles.cardTitle}>Account Information</Text>
          <Text style={styles.profileName}>
            {user?.firstName && user?.lastName
              ? `${user.firstName} ${user.lastName}`
              : user?.displayName ?? 'User'}
          </Text>
          <Text style={styles.profileEmail}>{user?.email}</Text>
          {user?.createdAt && (
            <Text style={styles.profileMeta}>
              Member since {new Date(user.createdAt).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
            </Text>
          )}
          {user?.id && (
            <Text style={styles.profileMeta}>User ID: {user.id}</Text>
          )}
        </Card>

        {/* Subscription */}
        <Card style={styles.card}>
          <Text style={styles.cardTitle}>Subscription</Text>
          {user?.tier === 'paid' ? (
            <>
              <View style={styles.subBadgePaid}>
                <Text style={styles.subBadgeTitlePaid}>Mealio Full Access</Text>
                <Text style={styles.subBadgeDesc}>
                  {entDetails && entDetails.isActive && !entDetails.willRenew && entDetails.expirationDate
                    ? `Full Access until ${formatExpiry(entDetails.expirationDate)}`
                    : 'Unlimited saved meals across all stores.'}
                </Text>
              </View>
              <Button
                label={portalLoading ? 'Loading…' : 'Manage Subscription'}
                variant="secondary"
                onPress={handleManageSubscription}
                loading={portalLoading}
                style={styles.manageBtn}
              />
              <Text style={styles.subHint}>Update payment method, view billing history, or cancel anytime.</Text>
            </>
          ) : (
            <>
              <View style={styles.subBadgeFree}>
                <Text style={styles.subBadgeTitleFree}>Free Plan</Text>
                <Text style={styles.subBadgeDesc}>Up to 3 saved meals. Upgrade for unlimited access.</Text>
              </View>

              {/* Billing period toggle */}
              <View style={styles.billingToggle}>
                <TouchableOpacity
                  style={[styles.billingToggleBtn, billing === 'monthly' && styles.billingToggleBtnActive]}
                  onPress={() => setBilling('monthly')}
                >
                  <Text style={[styles.billingToggleBtnText, billing === 'monthly' && styles.billingToggleBtnTextActive]}>Monthly</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.billingToggleBtn, billing === 'annual' && styles.billingToggleBtnActive]}
                  onPress={() => setBilling('annual')}
                >
                  <Text style={[styles.billingToggleBtnText, billing === 'annual' && styles.billingToggleBtnTextActive]}>Annual</Text>
                </TouchableOpacity>
              </View>

              <View style={styles.subPriceBox}>
                <Text style={styles.subPriceTitle}>Mealio Full Access</Text>
                <Text style={styles.subPrice}>
                  {selectedPkg?.product.priceString ?? fallbackPrice}
                </Text>
                <Text style={styles.subPricePeriod}>
                  {billing === 'annual' ? 'billed annually' : 'billed monthly'} · auto-renews · cancel anytime
                </Text>
                {(selectedPkg?.product as any)?.introductoryDiscount?.paymentMode === 'FREE_TRIAL' && (
                  <Text style={styles.subTrial}>
                    Includes a {(selectedPkg.product as any).introductoryDiscount.periodNumberOfUnits}-
                    {(selectedPkg.product as any).introductoryDiscount.periodUnit?.toLowerCase()} free trial.
                    After the trial, you will be automatically charged {selectedPkg.product.priceString}/
                    {billing === 'annual' ? 'year' : 'month'}.
                  </Text>
                )}
                <View style={styles.subFeatures}>
                  <Text style={styles.subFeatureItem}>· Unlimited saved meals</Text>
                </View>
              </View>

              <Button
                label={upgradeLoading ? 'Loading…' : 'Upgrade to Full Access'}
                variant="primary"
                onPress={handleUpgrade}
                loading={upgradeLoading}
                style={styles.manageBtn}
              />

              <View style={styles.subLinks}>
                <TouchableOpacity onPress={() => Linking.openURL('https://mealio.co/terms')}>
                  <Text style={styles.subLinkText}>Terms of Use</Text>
                </TouchableOpacity>
                <Text style={styles.subLinkSep}>·</Text>
                <TouchableOpacity onPress={() => Linking.openURL('https://mealio.co/privacy')}>
                  <Text style={styles.subLinkText}>Privacy Policy</Text>
                </TouchableOpacity>
              </View>

              <TouchableOpacity onPress={handleRestorePurchases} disabled={restoreLoading} style={styles.restoreLink}>
                <Text style={styles.restoreLinkText}>{restoreLoading ? 'Restoring…' : 'Restore Purchases'}</Text>
              </TouchableOpacity>
            </>
          )}
        </Card>

        {/* Kroger Cart */}
        <Card style={styles.card}>
          <Text style={styles.cardTitle}>Kroger Brands Integration</Text>
          {!krogerConnected ? (
            <View>
              <Text style={styles.krogerDesc}>
                Connect your Kroger account to add meal ingredients directly to your cart, with no extension needed. Works with Kroger, Ralphs, Fred Meyer, King Soopers, Harris Teeter, and more.
              </Text>
              <View style={styles.krogerBrandNote}>
                <Text style={styles.krogerBrandNoteText}>
                  Shop at King Soopers, Fred Meyer, Ralphs, or Harris Teeter? These stores use Kroger's login system, so you may see a Kroger sign-in screen. That is normal.
                </Text>
              </View>
              <Button
                label={krogerConnecting ? 'Opening Kroger…' : 'Connect Kroger Account'}
                variant="secondary"
                onPress={handleKrogerConnect}
                loading={krogerConnecting}
              />
            </View>
          ) : (
            <View>
              <View style={styles.krogerConnectedBadge}>
                <Text style={styles.krogerConnectedTitle}>Connected</Text>
                {Object.keys(krogerLocations).length === 0 ? (
                  <Text style={styles.krogerConnectedDesc}>No stores selected. Search below to add one.</Text>
                ) : (
                  Object.entries(krogerLocations).map(([sid, loc]) => (
                    <Text key={sid} style={styles.krogerConnectedDesc}>
                      {stores.find(s => s.id === sid)?.name ?? sid}: {loc.locationName}
                    </Text>
                  ))
                )}
              </View>

              {/* Store search */}
              <Text style={[styles.sectionSubLabel, { marginTop: 12 }]}>
                Add or change store location
              </Text>
              <View style={styles.krogerSearchRow}>
                <TextInput
                  style={styles.krogerZipInput}
                  placeholder="ZIP code"
                  placeholderTextColor={Colors.text3}
                  value={krogerZip}
                  onChangeText={setKrogerZip}
                  keyboardType="numeric"
                  maxLength={10}
                  returnKeyType="search"
                  onSubmitEditing={handleKrogerSearchStores}
                />
                <TouchableOpacity
                  style={[styles.krogerSearchBtn, (!krogerZip.trim() || krogerSearching) && { opacity: 0.5 }]}
                  onPress={handleKrogerSearchStores}
                  disabled={!krogerZip.trim() || krogerSearching}
                >
                  <Text style={styles.krogerSearchBtnText}>{krogerSearching ? '…' : 'Search'}</Text>
                </TouchableOpacity>
              </View>

              {krogerLocationsList.map((loc) => (
                <TouchableOpacity
                  key={loc.locationId}
                  style={[styles.krogerLocRow, krogerLocations[loc.storeId]?.locationId === loc.locationId && styles.krogerLocRowActive]}
                  onPress={() => handleKrogerSaveLocation(loc)}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.krogerLocName}>{loc.name}</Text>
                    <Text style={styles.krogerLocAddr} numberOfLines={1}>{loc.address}</Text>
                  </View>
                  {krogerLocations[loc.storeId]?.locationId === loc.locationId && (
                    <Text style={styles.krogerLocCheck}>✓</Text>
                  )}
                </TouchableOpacity>
              ))}

              <Button
                label="Disconnect Kroger"
                variant="ghost"
                size="sm"
                onPress={handleKrogerDisconnect}
                style={{ marginTop: 12 }}
              />
            </View>
          )}
        </Card>

        {/* Notifications — the always-available way in, for anyone who dismissed
            or denied the in-app ask. Hidden entirely where remote push can't
            work (Expo Go), since there'd be nothing to toggle. */}
        {pushStatus && pushStatus !== 'unsupported' && (
          <Card style={styles.card}>
            <Text style={styles.cardTitle}>Notifications</Text>
            <Text style={styles.pushDesc}>
              {pushStatus === 'on'
                ? "Push notifications are on. We'll only use them for things that need you, never marketing."
                : pushStatus === 'unregistered'
                // SAY THAT IT DID NOT WORK. This state used to render as "on":
                // the OS had said yes, no token could be obtained, and the
                // screen claimed success over a server that had never heard of
                // the device. Naming it is the difference between a user
                // waiting for notifications that cannot come and a user who
                // knows to try again.
                ? "We could not finish turning these on for this device. Everything else works; you'll get emails instead. Try again, and if it keeps failing this build may be missing its notification setup."
                : pushStatus === 'blocked'
                ? 'Notifications are turned off for Mealio in your device settings. Everything still works; you just get emails instead.'
                : "Get notified when something needs your attention. Everything works without them, and you'll get emails instead."}
            </Text>
            <Button
              label={
                pushStatus === 'on' ? 'Turn Off Notifications'
                : pushStatus === 'blocked' ? 'Open Settings'
                : pushStatus === 'unregistered' ? 'Try Again'
                : 'Turn On Notifications'
              }
              variant="secondary"
              onPress={handleTogglePush}
              loading={pushBusy}
            />
            {/* MEAL-217. Only while they are ON: choosing WHICH notifications
                to receive is a question that means nothing to someone who
                receives none, and offering it there would be a screen full of
                switches that change nothing. */}
            {pushStatus === 'on' && (
              <TouchableOpacity
                onPress={() => setNotifSettingsOpen(true)}
                testID="open-notification-settings"
                style={{ paddingVertical: 12 }}
              >
                <Text style={styles.linkRow}>Choose what we notify you about →</Text>
              </TouchableOpacity>
            )}
          </Card>
        )}

        {/* Change Password */}
        <Card style={styles.card}>
          <Text style={styles.cardTitle}>Change Password</Text>
          <Input
            label="Current password"
            placeholder="••••••••"
            value={currentPw}
            onChangeText={setCurrentPw}
            isPassword
          />
          <Input
            label="New password"
            placeholder="Min. 8 characters"
            value={newPw}
            onChangeText={setNewPw}
            isPassword
            error={pwError}
          />
          <Button
            label="Update Password"
            variant="secondary"
            onPress={handleChangePassword}
            loading={pwLoading}
          />
        </Card>

        {/* Creator Photo (if creator) */}
        {isCreator && (
          <Card style={styles.card}>
            <Text style={styles.cardTitle}>Creator Photo</Text>
            <View style={styles.creatorPhotoRow}>
              {creatorProfile?.photoUrl ? (
                <Image source={{ uri: creatorProfile.photoUrl }} style={styles.creatorPhoto} contentFit="cover" />
              ) : (
                <View style={[styles.creatorPhoto, styles.creatorPhotoPlaceholder]}>
                  <Text style={styles.creatorPhotoPlaceholderText}>No photo</Text>
                </View>
              )}
              <Button
                label={uploading ? 'Uploading...' : 'Change Photo'}
                variant="secondary"
                onPress={handlePhotoUpload}
                loading={uploading}
                style={styles.photoBtn}
              />
            </View>
          </Card>
        )}

        {/* Following */}
        {following.length > 0 && (
          <Card style={styles.card}>
            <Text style={styles.cardTitle}>Following ({following.length})</Text>
            {following.map((creator) => (
              <View key={creator.id} style={styles.followRow}>
                {creator.photoUrl ? (
                  <Image source={{ uri: creator.photoUrl }} style={styles.followAvatar} contentFit="cover" />
                ) : (
                  <View style={[styles.followAvatar, styles.followAvatarPlaceholder]}>
                    <Text style={styles.followAvatarText}>{creator.displayName?.[0]?.toUpperCase() ?? '?'}</Text>
                  </View>
                )}
                <Text style={styles.followName} numberOfLines={1}>{creator.displayName}</Text>
                <Button
                  label="Unfollow"
                  variant="ghost"
                  size="sm"
                  onPress={() => handleUnfollow(creator.id)}
                />
              </View>
            ))}
          </Card>
        )}

        {/* Deleted Meals */}
        {deletedMeals.length > 0 && (
          <Card style={styles.card}>
            <Text style={styles.cardTitle}>Deleted Meals ({deletedMeals.length})</Text>
            {deletedMeals.map((meal) => (
              <View key={meal.id} style={styles.deletedRow}>
                <Text style={styles.deletedName} numberOfLines={1}>{meal.name}</Text>
                <View style={styles.deletedActions}>
                  <Button
                    label="Restore"
                    variant="secondary"
                    size="sm"
                    onPress={() => handleRestore(meal.id)}
                    style={styles.actionBtn}
                  />
                  <Button
                    label="Delete"
                    variant="danger"
                    size="sm"
                    onPress={() => handlePermanentDelete(meal.id, meal.name)}
                    style={styles.actionBtn}
                  />
                </View>
              </View>
            ))}
          </Card>
        )}

        {/* Log out of grocery stores */}
        <Button
          label="Log Out of Grocery Stores"
          variant="secondary"
          loading={storeLogoutLoading}
          onPress={handleStoreLogout}
          style={styles.storeLogoutBtn}
        />
        <Text style={styles.storeLogoutHint}>
          Signs you out of every connected grocery store.
        </Text>

        {/* Sign Out */}
        <Button
          label="Sign Out"
          variant="danger"
          onPress={handleLogout}
          style={styles.signOutBtn}
        />

        {/*
          Dev-only: put the one-time explainers back.
          `resetFirstRun()` existed for the tests and had no caller in the app, so
          re-reading the first-run copy meant editing code or reinstalling — and on
          iOS a reinstall may not even clear it, because the keychain entry can
          outlive the app. Behind `__DEV__`, so it is compiled out of every release
          build and cannot be reached by a user.
        */}
        {__DEV__ && (
          <TouchableOpacity
            onPress={async () => {
              await resetFirstRun();
              Alert.alert('First run reset', 'Restart the app to see the welcome pitch and the Choose Products explainer again.');
            }}
            style={styles.devResetBtn}
          >
            <Text style={styles.devResetText}>Reset first-run explainers (dev)</Text>
          </TouchableOpacity>
        )}

        {/* Delete Account */}
        <TouchableOpacity onPress={handleDeleteAccount} disabled={deleteLoading} style={styles.deleteAccountBtn}>
          <Text style={styles.deleteAccountText}>{deleteLoading ? 'Deleting…' : 'Delete Account'}</Text>
        </TouchableOpacity>

        <Modal
          visible={deleteConfirmVisible}
          transparent
          animationType="fade"
          onRequestClose={() => { if (!deleteLoading) setDeleteConfirmVisible(false); }}
        >
          <View style={styles.deleteModalOverlay}>
            <View style={styles.deleteModalCard}>
              <Text style={styles.deleteModalTitle}>Delete Account</Text>
              <Text style={styles.deleteModalBody}>
                This permanently deletes your account, saved meals, and follows. If you&apos;re a creator, your published meals are removed from Discover. This cannot be undone.
              </Text>
              <Text style={styles.deleteModalLabel}>Type "Delete Account" to confirm:</Text>
              <TextInput
                value={deleteConfirmText}
                onChangeText={setDeleteConfirmText}
                placeholder="Delete Account"
                placeholderTextColor={Colors.text3}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!deleteLoading}
                style={styles.deleteModalInput}
              />
              <View style={styles.deleteModalBtnRow}>
                <TouchableOpacity
                  onPress={() => setDeleteConfirmVisible(false)}
                  disabled={deleteLoading}
                  style={styles.deleteModalCancel}
                >
                  <Text style={styles.deleteModalCancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={confirmDeleteAccount}
                  disabled={deleteConfirmText !== 'Delete Account' || deleteLoading}
                  style={[
                    styles.deleteModalConfirm,
                    (deleteConfirmText !== 'Delete Account' || deleteLoading) && styles.deleteModalConfirmDisabled,
                  ]}
                >
                  <Text style={styles.deleteModalConfirmText}>{deleteLoading ? 'Deleting…' : 'Delete'}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>

        <NotificationSettingsSheet
          visible={notifSettingsOpen}
          onClose={() => setNotifSettingsOpen(false)}
        />
      </KeyboardAwareScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  scroll: { padding: 16, paddingBottom: 40 },
  pageTitle: { fontSize: 28, fontFamily: 'Inter_700Bold', color: Colors.text1, marginBottom: 16 },
  card: { marginBottom: 16 },
  cardTitle: { fontSize: 17, fontFamily: 'Inter_700Bold', color: Colors.text1, marginBottom: 14 },
  profileName: { fontSize: 17, fontFamily: 'Inter_600SemiBold', color: Colors.text1, marginBottom: 2 },
  profileEmail: { fontSize: 14, fontFamily: 'Inter_400Regular', color: Colors.text2, marginBottom: 6 },
  profileMeta: { fontSize: 12, fontFamily: 'Inter_400Regular', color: Colors.text3, marginTop: 4 },
  subBadgePaid: {
    borderRadius: 12,
    padding: 12,
    backgroundColor: '#f0fdf4',
    borderWidth: 1,
    borderColor: '#bbf7d0',
    marginBottom: 12,
  },
  subBadgeFree: {
    borderRadius: 12,
    padding: 12,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: 12,
  },
  subBadgeTitlePaid: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: '#14532d', marginBottom: 2 },
  subBadgeTitleFree: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: Colors.text1, marginBottom: 2 },
  subBadgeDesc: { fontSize: 13, fontFamily: 'Inter_400Regular', color: Colors.text2 },
  manageBtn: { marginBottom: 8 },
  subHint: { fontSize: 12, fontFamily: 'Inter_400Regular', color: Colors.text3 },
  subPriceBox: {
    borderRadius: 12,
    padding: 14,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: 12,
    alignItems: 'center',
  },
  subPriceTitle: { fontSize: 13, fontFamily: 'Inter_500Medium', color: Colors.text2, marginBottom: 4 },
  subPrice: { fontSize: 28, fontFamily: 'Inter_700Bold', color: Colors.text1, marginBottom: 2 },
  subPricePeriod: { fontSize: 12, fontFamily: 'Inter_400Regular', color: Colors.text3, textAlign: 'center' },
  subTrial: { fontSize: 12, fontFamily: 'Inter_500Medium', color: Colors.brand, marginTop: 6, textAlign: 'center', lineHeight: 17 },
  subFeatures: { marginTop: 10, alignSelf: 'flex-start', width: '100%' },
  subFeatureItem: { fontSize: 13, fontFamily: 'Inter_400Regular', color: Colors.text2, marginBottom: 3 },
  subLinks: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, marginBottom: 4 },
  subLinkText: { fontSize: 12, fontFamily: 'Inter_400Regular', color: Colors.text3, textDecorationLine: 'underline' },
  subLinkSep: { fontSize: 12, color: Colors.text3 },
  billingToggle: {
    flexDirection: 'row',
    backgroundColor: Colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: 12,
    overflow: 'hidden',
  },
  billingToggleBtn: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
  },
  billingToggleBtnActive: {
    backgroundColor: Colors.brand,
  },
  billingToggleBtnText: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.text2,
  },
  billingToggleBtnTextActive: {
    color: '#fff',
  },
  restoreLink: { alignItems: 'center', paddingVertical: 8 },
  restoreLinkText: { fontSize: 13, fontFamily: 'Inter_400Regular', color: Colors.text3 },
  devResetBtn: { alignItems: 'center', paddingVertical: 10, marginTop: 4 },
  devResetText: { fontSize: 12, fontFamily: 'Inter_400Regular', color: Colors.text3 },
  deleteAccountBtn: { alignItems: 'center', paddingVertical: 12, marginTop: 4, marginBottom: 8 },
  deleteAccountText: { fontSize: 13, fontFamily: 'Inter_400Regular', color: Colors.text3, textDecorationLine: 'underline' },
  deleteModalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 28 },
  deleteModalCard: { width: '100%', maxWidth: 420, backgroundColor: '#fff', borderRadius: 18, padding: 22 },
  deleteModalTitle: { fontSize: 18, fontFamily: 'Inter_700Bold', color: Colors.text1, marginBottom: 8 },
  deleteModalBody: { fontSize: 14, fontFamily: 'Inter_400Regular', color: Colors.text2, lineHeight: 20, marginBottom: 16 },
  deleteModalLabel: { fontSize: 13, fontFamily: 'Inter_600SemiBold', color: Colors.text2, marginBottom: 8 },
  deleteModalInput: { borderWidth: 1.5, borderColor: Colors.border, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, fontFamily: 'Inter_400Regular', color: Colors.text1, marginBottom: 18 },
  deleteModalBtnRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, alignItems: 'center' },
  deleteModalCancel: { paddingVertical: 12, paddingHorizontal: 18, borderRadius: 12 },
  deleteModalCancelText: { fontSize: 15, fontFamily: 'Inter_600SemiBold', color: Colors.text2 },
  deleteModalConfirm: { paddingVertical: 12, paddingHorizontal: 22, borderRadius: 12, backgroundColor: Colors.brand },
  deleteModalConfirmDisabled: { backgroundColor: Colors.borderStrong },
  deleteModalConfirmText: { fontSize: 15, fontFamily: 'Inter_700Bold', color: '#fff' },
  creatorPhotoRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  creatorPhoto: { width: 72, height: 72, borderRadius: 36, backgroundColor: Colors.surface },
  creatorPhotoPlaceholder: { justifyContent: 'center', alignItems: 'center' },
  creatorPhotoPlaceholderText: { fontSize: 12, color: Colors.text3, fontFamily: 'Inter_400Regular' },
  photoBtn: { flex: 1 },
  followRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  followAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    marginRight: 10,
  },
  followAvatarPlaceholder: {
    backgroundColor: Colors.brand,
    justifyContent: 'center',
    alignItems: 'center',
  },
  followAvatarText: { fontSize: 16, fontFamily: 'Inter_700Bold', color: '#fff' },
  followName: { flex: 1, fontSize: 15, fontFamily: 'Inter_500Medium', color: Colors.text1 },
  deletedRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  deletedName: { flex: 1, fontSize: 15, fontFamily: 'Inter_500Medium', color: Colors.text2 },
  deletedActions: { flexDirection: 'row', gap: 8 },
  actionBtn: { minWidth: 72 },
  storeLogoutBtn: { marginTop: 8 },
  storeLogoutHint: { fontSize: 12, color: Colors.text3, fontFamily: 'Inter_400Regular', marginTop: 6, marginBottom: 4, textAlign: 'center' },
  signOutBtn: { marginTop: 8 },
  krogerDesc: { fontSize: 13, fontFamily: 'Inter_400Regular', color: Colors.text2, marginBottom: 10, lineHeight: 19 },
  linkRow: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: Colors.brand },
  pushDesc: { fontSize: 13, fontFamily: 'Inter_400Regular', color: Colors.text2, marginBottom: 10, lineHeight: 19 },
  krogerBrandNote: {
    backgroundColor: Colors.surface,
    borderRadius: 10,
    padding: 10,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  krogerBrandNoteText: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    color: Colors.text2,
    lineHeight: 18,
  },
  krogerConnectedBadge: {
    borderRadius: 12,
    padding: 12,
    backgroundColor: '#f0fdf4',
    borderWidth: 1,
    borderColor: '#bbf7d0',
    marginBottom: 4,
  },
  krogerConnectedTitle: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: '#14532d', marginBottom: 2 },
  krogerConnectedDesc: { fontSize: 13, fontFamily: 'Inter_400Regular', color: '#166534' },
  sectionSubLabel: { fontSize: 12, fontFamily: 'Inter_600SemiBold', color: Colors.text2, marginBottom: 8 },
  krogerSearchRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  krogerZipInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    backgroundColor: Colors.surfaceRaised,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: Colors.text1,
  },
  krogerSearchBtn: {
    backgroundColor: Colors.brand,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    justifyContent: 'center',
  },
  krogerSearchBtnText: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: '#fff' },
  krogerLocRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: 6,
    backgroundColor: Colors.surfaceRaised,
  },
  krogerLocRowActive: { borderColor: Colors.brand, backgroundColor: Colors.brandLight },
  krogerLocName: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: Colors.text1, marginBottom: 2 },
  krogerLocAddr: { fontSize: 12, fontFamily: 'Inter_400Regular', color: Colors.text3 },
  krogerLocCheck: { fontSize: 16, color: Colors.brand, marginLeft: 8 },
});
