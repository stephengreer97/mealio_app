import React, { useState, useEffect, useRef } from 'react';
import { View, ActivityIndicator, TouchableOpacity, Text } from 'react-native';
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

  useEffect(() => {
    Linking.getInitialURL().then((url) => {
      if (url) handleDeepLink(url);
    });

    const subscription = Linking.addEventListener('url', ({ url }) => handleDeepLink(url));
    return () => subscription.remove();
  }, []);

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
      }
    } else {
      setDeepLink(link);
    }
  }

  function renderMain() {
    if (isLoading) return null;
    if (user) return <MainTabs />;
    if (showAuth) return <AuthStack />;
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
    <>
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
    </>
  );
}
