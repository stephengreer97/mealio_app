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
import { CartJobProvider } from './src/context/CartJobContext';
import RootNavigator from './src/navigation/RootNavigator';
import { installConsoleCapture } from './src/lib/logBuffer';
import WebViewVersionProbe from './src/components/WebViewVersionProbe';

SplashScreen.preventAutoHideAsync();

// Capture console output (redacted) into an in-memory ring buffer so users can
// attach recent diagnostic logs to a bug report. Runs once, before anything logs.
installConsoleCapture();

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
      <AuthProvider>
        <CartJobProvider>
          <NavigationContainer>
            <StatusBar style="auto" />
            <RootNavigator />
          </NavigationContainer>
        </CartJobProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
