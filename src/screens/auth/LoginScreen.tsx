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
import Svg, { Path, G } from 'react-native-svg';
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
  const googleEnabled = Platform.OS !== 'android' || !!androidClientId;
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
  return (
    <Svg width={20} height={20} viewBox="0 0 814 1000">
      <Path fill="#fff" d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76 0-103.7 40.8-165.9 40.8s-105-37.5-165.4-124.7c-69.2-103.7-132.5-261.7-132.5-412.6 0-227.1 148.7-347 295-347 74.1 0 135.9 48.7 182 48.7 43.4 0 112.7-51.7 195.1-51.7 31.3 0 108.2 2.6 168.6 80.6zm-80.3-220.2c37.7-44.6 63.4-107 63.4-169.3 0-8.7-.6-17.4-2.1-24.8-60.4 2.2-132.5 40.2-175.8 90.4-34.9 40.2-65.3 102.6-65.3 163.7 0 9.3 1.6 18.6 2.1 21.7 3.7.6 9.8 1.6 15.9 1.6 54.3 0 121.2-36.2 161.8-83.3z"/>
    </Svg>
  );
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
