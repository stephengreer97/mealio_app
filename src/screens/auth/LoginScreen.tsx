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

  const [googleRequest, googleResponse, googlePromptAsync] = Google.useAuthRequest({
    clientId: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_WEB,
    iosClientId: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_IOS,
    androidClientId: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_ANDROID,
  });

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
    <View style={styles.iconWrap}>
      {/* Simple G colored block — replace with an SVG asset if desired */}
      <Text style={styles.googleG}>G</Text>
    </View>
  );
}

function AppleIcon() {
  return (
    <View style={styles.iconWrap}>
      <Text style={[styles.googleG, styles.appleA]}></Text>
    </View>
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
  iconWrap: { width: 20, alignItems: 'center' },
  googleG: {
    fontSize: 16,
    fontFamily: 'Inter_700Bold',
    color: '#4285F4',
  },
  appleA: { color: '#fff' },
});
