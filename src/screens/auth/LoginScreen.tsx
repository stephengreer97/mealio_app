import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  Platform,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-aware-scroll-view';
import { SafeAreaView } from 'react-native-safe-area-context';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as WebBrowser from 'expo-web-browser';
import Svg, { Path } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';
import * as Google from 'expo-auth-session/providers/google';
import * as AppleAuthentication from 'expo-apple-authentication';
import { AuthStackParamList } from '../../navigation/AuthStack';
import { useAuth } from '../../context/AuthContext';
import { auth } from '../../lib/api';
import { Colors, Radius } from '../../constants/colors';
import Input from '../../components/ui/Input';
import Button from '../../components/ui/Button';

WebBrowser.maybeCompleteAuthSession();

type Props = { navigation: NativeStackNavigationProp<AuthStackParamList, 'Login'> };

export default function LoginScreen({ navigation }: Props) {
  const { login, loginWithToken } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [socialLoading, setSocialLoading] = useState<'google' | 'apple' | null>(null);
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});

  const androidClientId = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_ANDROID;
  const iosClientId = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_IOS;
  const webClientId = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_WEB;
  // Require a client id for THIS platform before configuring the hook —
  // useAuthRequest throws during render when given undefined ids, which in
  // a Release build is an instant crash with no red screen. (Caught by the
  // Maestro CI lane when a sim build went out without env vars.)
  const googleEnabled =
    Platform.OS === 'android' ? !!androidClientId : !!(iosClientId || webClientId);
  const [googleRequest, googleResponse, googlePromptAsync] = Google.useAuthRequest(
    googleEnabled
      ? {
          clientId: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_WEB,
          iosClientId: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_IOS,
          androidClientId,
        }
      : null as any
  );

  useEffect(() => {
    if (googleResponse?.type === 'success') {
      const idToken = googleResponse.authentication?.idToken;
      if (idToken) {
        handleGoogleToken(idToken);
      } else {
        setSocialLoading(null);
        Alert.alert('Sign In Failed', 'Could not get Google credentials. Please try again.');
      }
    } else if (googleResponse?.type === 'error' || googleResponse?.type === 'dismiss') {
      setSocialLoading(null);
    }
  }, [googleResponse]);

  function validate() {
    const e: typeof errors = {};
    if (!email.trim()) e.email = 'Email is required';
    else if (!/\S+@\S+\.\S+/.test(email)) e.email = 'Invalid email';
    if (!password) e.password = 'Password is required';
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleLogin() {
    if (!validate()) return;
    setLoading(true);
    try {
      const result = await login(email.trim().toLowerCase(), password);
      if (result.requiresVerification) {
        navigation.navigate('CheckEmail', { email: email.trim().toLowerCase() });
      } else if (result.requiresTwoFactor) {
        navigation.navigate('OTP', { twoFactorToken: result.twoFactorToken, email: email.trim().toLowerCase() });
      }
      // If successful login, AuthContext updates user and RootNavigator handles navigation
    } catch (err: any) {
      Alert.alert('Login Failed', err.message || 'Invalid email or password');
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogleSignIn() {
    setSocialLoading('google');
    try {
      await googlePromptAsync();
      // result handled in useEffect
    } catch {
      setSocialLoading(null);
      Alert.alert('Sign In Failed', 'Could not connect to Google. Please try again.');
    }
  }

  async function handleGoogleToken(idToken: string) {
    try {
      const result = await auth.oauthGoogle(idToken);
      if (result.accessToken) {
        await loginWithToken(result.accessToken);
      }
    } catch (err: any) {
      Alert.alert('Sign In Failed', err.message || 'Google sign in failed. Please try again.');
    } finally {
      setSocialLoading(null);
    }
  }

  async function handleAppleSignIn() {
    setSocialLoading('apple');
    try {
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });

      if (!credential.identityToken) {
        throw new Error('No identity token from Apple');
      }

      const user = credential.fullName
        ? {
            name: {
              firstName: credential.fullName.givenName ?? undefined,
              lastName: credential.fullName.familyName ?? undefined,
            },
            email: credential.email ?? undefined,
          }
        : undefined;

      const result = await auth.oauthApple(credential.identityToken, user);
      if (result.accessToken) {
        await loginWithToken(result.accessToken);
      }
    } catch (err: any) {
      if (err.code !== 'ERR_REQUEST_CANCELED') {
        Alert.alert('Sign In Failed', err.message || 'Apple sign in failed. Please try again.');
      }
    } finally {
      setSocialLoading(null);
    }
  }

  const anyLoading = loading || !!socialLoading;

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAwareScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" enableOnAndroid extraScrollHeight={24}>
          <View style={styles.header}>
            <Text style={styles.logo}>Mealio</Text>
            <Text style={styles.tagline}>Shop meals, we'll fill the cart.</Text>
          </View>

          <View style={styles.form}>
            <Text style={styles.title}>Welcome back</Text>
            <Text style={styles.subtitle}>Sign in to your account</Text>

            <Input
              label="Email"
              placeholder="you@example.com"
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoComplete="email"
              error={errors.email}
            />

            <Input
              label="Password"
              placeholder="••••••••"
              value={password}
              onChangeText={setPassword}
              isPassword
              autoComplete="password"
              error={errors.password}
            />

            <TouchableOpacity onPress={() => navigation.navigate('ForgotPassword')} style={styles.forgotBtn}>
              <Text style={styles.forgotText}>Forgot password?</Text>
            </TouchableOpacity>

            <Button label="Sign In" onPress={handleLogin} loading={loading} disabled={anyLoading} style={styles.submitBtn} />

            <View style={styles.divider}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>or continue with</Text>
              <View style={styles.dividerLine} />
            </View>

            {googleEnabled && (
              <TouchableOpacity
                style={[styles.socialBtn, anyLoading && styles.socialBtnDisabled]}
                onPress={handleGoogleSignIn}
                disabled={anyLoading || !googleRequest}
                activeOpacity={0.7}
              >
                <GoogleIcon />
                <Text style={styles.socialBtnText}>
                  {socialLoading === 'google' ? 'Connecting…' : 'Continue with Google'}
                </Text>
              </TouchableOpacity>
            )}

            {Platform.OS === 'ios' && (
              <TouchableOpacity
                style={[styles.socialBtn, styles.appleBtn, anyLoading && styles.socialBtnDisabled]}
                onPress={handleAppleSignIn}
                disabled={anyLoading}
                activeOpacity={0.7}
              >
                <AppleIcon />
                <Text style={[styles.socialBtnText, styles.appleBtnText]}>
                  {socialLoading === 'apple' ? 'Connecting…' : 'Continue with Apple'}
                </Text>
              </TouchableOpacity>
            )}

            <View style={styles.divider}>
              <View style={styles.dividerLine} />
            </View>

            <Button
              label="Create an account"
              variant="secondary"
              onPress={() => navigation.navigate('Signup')}
              disabled={anyLoading}
            />
          </View>
      </KeyboardAwareScrollView>
    </SafeAreaView>
  );
}

function GoogleIcon() {
  return (
    <Svg width={20} height={20} viewBox="0 0 48 48">
      <Path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
      <Path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
      <Path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
      <Path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
      <Path fill="none" d="M0 0h48v48H0z"/>
    </Svg>
  );
}

function AppleIcon() {
  return <Ionicons name="logo-apple" size={20} color="#fff" />;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  scroll: { flexGrow: 1, paddingHorizontal: 24, paddingBottom: 40 },
  header: { alignItems: 'center', paddingTop: 48, paddingBottom: 32 },
  logo: {
    fontSize: 42,
    fontFamily: 'Pacifico_400Regular',
    color: Colors.brand,
    marginBottom: 8,
  },
  tagline: {
    fontSize: 16,
    fontFamily: 'Inter_400Regular',
    color: Colors.text2,
  },
  form: { flex: 1 },
  title: {
    fontSize: 24,
    fontFamily: 'Inter_700Bold',
    color: Colors.text1,
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 16,
    fontFamily: 'Inter_400Regular',
    color: Colors.text2,
    marginBottom: 24,
  },
  forgotBtn: { alignSelf: 'flex-end', marginTop: -8, marginBottom: 20 },
  forgotText: {
    fontSize: 14,
    fontFamily: 'Inter_500Medium',
    color: Colors.brand,
  },
  submitBtn: { marginBottom: 16 },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 16,
  },
  dividerLine: { flex: 1, height: 1, backgroundColor: Colors.border },
  dividerText: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    color: Colors.text3,
    marginHorizontal: 12,
  },
  socialBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    borderWidth: 1.5,
    borderColor: Colors.border,
    borderRadius: Radius.button,
    paddingVertical: 13,
    marginBottom: 12,
    backgroundColor: Colors.surface,
  },
  socialBtnDisabled: { opacity: 0.5 },
  appleBtn: {
    backgroundColor: '#000',
    borderColor: '#000',
  },
  socialBtnText: {
    fontSize: 15,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.text1,
  },
  appleBtnText: { color: '#fff' },
});
