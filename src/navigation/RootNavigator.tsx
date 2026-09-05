import React, { useState, useEffect, useRef } from 'react';
import { View, ActivityIndicator, TouchableOpacity, Text, Alert } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';
import * as Linking from 'expo-linking';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAuth } from '../context/AuthContext';
import { Colors } from '../constants/colors';
import AuthStack from './AuthStack';
import MainTabs from './MainTabs';
import SharedMealScreen from '../screens/shared/SharedMealScreen';
import MealDetailSheet from '../components/MealDetailSheet';
import StoreSelectorSheet from '../components/StoreSelectorSheet';
import { presetMeals as presetMealsApi } from '../lib/api';
import { PresetMeal } from '../types';
import DiscoverScreen from '../screens/discover/DiscoverScreen';
import { DeepLinkBusyContext } from '../context/DeepLinkContext';

const GuestStack = createNativeStackNavigator();

type DeepLink =
  | { type: 'shared'; token: string }
  | { type: 'preset'; id: string };

function parseDeepLink(url: string): DeepLink | null {
  // /meal/p/PRESET_ID  → preset meal
  const presetMatch = url.match(/\/meal\/p\/([^/?#]+)/);
  if (presetMatch) return { type: 'preset', id: presetMatch[1] };

  // /meal/TOKEN  → shared user meal
  const sharedMatch = url.match(/\/meal\/([^/?#]+)/);
  if (sharedMatch) return { type: 'shared', token: sharedMatch[1] };

  return null;
}

function parseVerifiedToken(url: string): string | null {
  // mealio://verified?token=xxx
  const match = url.match(/verified[?&]token=([^&]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export default function RootNavigator() {
  const { user, isLoading, loginWithToken } = useAuth();
  const [deepLink, setDeepLink] = useState<DeepLink | null>(null);
  const [showAuth, setShowAuth] = useState(false);
  const splashHidden = useRef(false);

  function hideSplash() {
    if (!splashHidden.current) {
      splashHidden.current = true;
      SplashScreen.hideAsync();
    }
  }

  // For logged-in users and auth stack: hide splash as soon as auth resolves
  useEffect(() => {
    if (!isLoading && (user || showAuth)) {
      hideSplash();
    }
  }, [isLoading, user, showAuth]);

  // Preset meal deep link state
  const [presetMeal, setPresetMeal] = useState<PresetMeal | null>(null);
  const [presetDetailVisible, setPresetDetailVisible] = useState(false);
  const presetDetailVisibleRef = useRef(false);
  const [storeSelectorVisible, setStoreSelectorVisible] = useState(false);

  // A deep link is resolving. Distinct from its sheet being visible: the gap
  // between "we know there is a link" and "the meal has come back from the API"
  // is a network round-trip, and it is exactly the window the first-run welcome
  // used to slip through. `initialUrlChecked` covers the earlier gap still —
  // before `getInitialURL` has even answered we do not yet know whether this
  // launch came from a link, so we assume it might have.
  const [initialUrlChecked, setInitialUrlChecked] = useState(false);
  const [deepLinkPending, setDeepLinkPending] = useState(false);

  useEffect(() => {
    Linking.getInitialURL()
      .then((url) => { if (url) handleDeepLink(url); })
      .catch(() => {})
      .finally(() => setInitialUrlChecked(true));

    const subscription = Linking.addEventListener('url', ({ url }) => handleDeepLink(url));
    return () => subscription.remove();
  }, []);

  // Nothing inside the tabs can see these sheets — they are rendered as siblings
  // of the entire app — so this is published through a context for the one thing
  // that has to know: the first-run welcome, which is a Modal and would stack.
  // See src/context/DeepLinkContext.ts.
  const deepLinkBusy =
    !initialUrlChecked
    || deepLinkPending
    || presetDetailVisible
    || storeSelectorVisible
    || deepLink !== null;

  async function handleDeepLink(url: string) {
    // Email verification callback — mealio://verified?token=xxx
    const verifiedToken = parseVerifiedToken(url);
    if (verifiedToken) {
      try {
        await loginWithToken(verifiedToken);
      } catch {
        // Token invalid — user will stay on auth screen
      }
      return;
    }

    const link = parseDeepLink(url);
    if (!link) return;

    // Claim the screen synchronously, before the API round-trip below. Anything
    // that would open a Modal of its own now waits for us.
    setDeepLinkPending(true);

    if (link.type === 'preset') {
      try {
        const meal = await presetMealsApi.getById(link.id);
        setPresetMeal(meal);
        // If a modal is already visible, close it first to avoid stacked Modals
        // blocking touch events on iOS. Use a ref to avoid stale closure.
        if (presetDetailVisibleRef.current) {
          setPresetDetailVisible(false);
          presetDetailVisibleRef.current = false;
          await new Promise((r) => setTimeout(r, 300));
        }
        presetDetailVisibleRef.current = true;
        setPresetDetailVisible(true);
      } catch {
        // Silently ignore — bad/expired link
      } finally {
        // Hands over to `presetDetailVisible` on success; on a bad link this is
        // the only thing holding the screen, and it lets go.
        setDeepLinkPending(false);
      }
    } else {
      setDeepLink(link);
      setDeepLinkPending(false);
    }
  }

  function renderMain() {
    if (isLoading) return null;
    // ── The tab tree belongs to ONE account (MEAL-154) ──────────────────────
    //
    // `handleDeepLink` above calls `loginWithToken` from a listener registered
    // app-wide, with no signed-in check. So on a shared phone A is signed in, B
    // taps the verification link in their own email, and `user` goes A → B
    // without ever passing through null. `user` stays truthy across that, so
    // without a key React reconciles the SAME `MainTabs` element and every
    // screen under it keeps the state it fetched for A. MyMealsScreen reloads
    // only in a `useFocusEffect` with no deps and DiscoverScreen's saved map and
    // meal count are the same shape, so B — whose tab did not change and
    // therefore never refocuses — is looking at A's saved meals and A's
    // groceries. CreatorPortalScreen loads once on mount and
    // never reload at all.
    //
    // Keying the tree on the account id makes that structural instead of
    // per-screen: an account change gives every screen under here a fresh mount,
    // so each one refetches through the load path it already has, and no screen
    // added later has to remember that this hazard exists. The alternative —
    // teaching each screen to clear and refetch on `useSessionEnd` — leaves A's
    // rows rendered for the whole round trip the refetch takes (that IS the
    // leak), needs every one of ~40 pieces of MyMealsScreen state enumerated,
    // and is one forgotten screen away from being open again.
    //
    // Keyed on the ID, never on the object, for the same reason
    // `useSessionEnd` and `beginSession` are: a token renewal or a `refreshUser`
    // hands down a brand new User for the same person several times a session,
    // and remounting the tabs there would throw away a live user's half-typed
    // meal form and their place in the list. An unchanged id is an unchanged
    // key, so React does not remount.
    //
    // This does not replace the teardowns MEAL-146 added. Those cover state that
    // lives ABOVE this element (the log buffer, the cart engine, the prewarm
    // cache) and work still in flight from a screen that has since been
    // unmounted — neither of which a remount here reaches.
    if (user) return <MainTabs key={user.id} />;
    if (showAuth) return <AuthStack onClose={() => setShowAuth(false)} />;
    return (
      <GuestStack.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: Colors.brand },
          headerTintColor: '#fff',
          headerTitleStyle: { fontFamily: 'Inter_700Bold', fontSize: 18 },
        }}
      >
        <GuestStack.Screen
          name="GuestDiscover"
          component={DiscoverScreen}
          initialParams={{ onSignIn: () => setShowAuth(true), onReady: hideSplash }}
          options={{ headerShown: false }}
        />
      </GuestStack.Navigator>
    );
  }

  return (
    <DeepLinkBusyContext.Provider value={deepLinkBusy}>
      {renderMain()}

      {/* Shared user meal deep link */}
      <SharedMealScreen
        token={deepLink?.type === 'shared' ? deepLink.token : null}
        onClose={() => setDeepLink(null)}
      />

      {/* Preset meal deep link */}
      <MealDetailSheet
        visible={presetDetailVisible}
        meal={presetMeal}
        mode="view"
        onClose={() => { presetDetailVisibleRef.current = false; setPresetDetailVisible(false); }}
        onPressSave={() => {
          // Logged-out users can open a preset via deep link — gate the save
          // behind sign-in instead of letting it hit a silent 401.
          if (!user) {
            setPresetDetailVisible(false);
            presetDetailVisibleRef.current = false;
            Alert.alert('Sign In Required', 'Create an account or sign in to save meals.', [
              { text: 'Not now', style: 'cancel' },
              { text: 'Sign In', onPress: () => setShowAuth(true) },
            ]);
            return;
          }
          setPresetDetailVisible(false);
          setStoreSelectorVisible(true);
        }}
      />
      <StoreSelectorSheet
        visible={storeSelectorVisible}
        meal={presetMeal}
        onClose={() => setStoreSelectorVisible(false)}
        onSaved={() => setStoreSelectorVisible(false)}
      />
    </DeepLinkBusyContext.Provider>
  );
}
