import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import {
  useFonts,
  Inter_400Regular,
  Inter_400Regular_Italic,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from '@expo-google-fonts/inter';
import { Pacifico_400Regular } from '@expo-google-fonts/pacifico';
import * as SplashScreen from 'expo-splash-screen';
import { AuthProvider } from './src/context/AuthContext';
import { LoginPrewarmProvider } from './src/context/LoginPrewarmContext';
import { CartJobProvider } from './src/context/CartJobContext';
import { CreatorDraftsProvider } from './src/context/CreatorDraftsContext';
import RootNavigator from './src/navigation/RootNavigator';
import { navigationRef } from './src/navigation/navigationRef';
import { installConsoleCapture } from './src/lib/logBuffer';
import WebViewVersionProbe from './src/components/WebViewVersionProbe';
import FingerprintProbe from './src/components/FingerprintProbe';
import PushRegistrar from './src/components/PushRegistrar';
import { configureNotificationHandler } from './src/lib/push';
import { loadEpoch } from './src/lib/store-session-epoch-storage';
import AutomationConfigLoader from './src/components/AutomationConfigLoader';
import StoreCatalogLoader from './src/components/StoreCatalogLoader';

SplashScreen.preventAutoHideAsync();

// Capture console output (redacted) into an in-memory ring buffer so users can
// attach recent diagnostic logs to a bug report. Runs once, before anything logs.
installConsoleCapture();

// Decides how a notification arriving while the app is open is presented. Must
// be set before any listener can fire, so it runs at module scope like the log
// capture above rather than in an effect.
configureNotificationHandler();

// Read the sign-out generation into memory before any run can build a script.
//
// The rail's cache keys are stamped with it synchronously, so it has to be in
// place first; a run that started before this resolved would read generation
// zero and see caches the user had already signed away. Fire-and-forget on
// purpose -- it is one keychain read, it happens while the splash screen is
// still up, and a failure reads as generation zero, which is the pre-existing
// key and the safe direction.
void loadEpoch();

export default function App() {
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_400Regular_Italic,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    Pacifico_400Regular,
  });

  // Don't hide splash here — RootNavigator handles it once content is ready
  if (!fontsLoaded) return null;

  return (
    <SafeAreaProvider>
      <WebViewVersionProbe />
      {/* Outside AuthProvider on purpose: GET /api/stores is public, and the
          signed-out deep link into a shared meal offers the same store picker.
          Gates nothing — the picker renders from the bundled list until this
          lands, and forever if it never does. */}
      <StoreCatalogLoader />
      {__DEV__ && <FingerprintProbe />}
      <AuthProvider>
        {/* Inside AuthProvider (needs a token) but outside the cart tree, so the
            remote store config is already in memory before any cart run starts. */}
        <AutomationConfigLoader />
        {/* Inside AuthProvider (needs a user and a token) and outside the
            navigator, because MainTabs reads the count to badge the Creator tab
            and the review screen writes it back after a decision. */}
        <CreatorDraftsProvider>
        <LoginPrewarmProvider>
          <CartJobProvider>
            <NavigationContainer ref={navigationRef}>
              <StatusBar style="auto" />
              <PushRegistrar />
              <RootNavigator />
            </NavigationContainer>
          </CartJobProvider>
        </LoginPrewarmProvider>
        </CreatorDraftsProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
