import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-aware-scroll-view';
import { SafeAreaView } from 'react-native-safe-area-context';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { AuthStackParamList } from '../../navigation/AuthStack';
import { useAuth } from '../../context/AuthContext';
import { Colors, Radius } from '../../constants/colors';
import Input from '../../components/ui/Input';
import Button from '../../components/ui/Button';

type Props = { navigation: NativeStackNavigationProp<AuthStackParamList, 'Login'> };

export default function LoginScreen({ navigation }: Props) {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});

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

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAwareScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" enableOnAndroid extraScrollHeight={24}>
          <View style={styles.header}>
            <Text style={styles.logo}>Mealio</Text>
            <Text style={styles.tagline}>Grocery shopping, simplified.</Text>
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

            <Button label="Sign In" onPress={handleLogin} loading={loading} style={styles.submitBtn} />

            <View style={styles.divider}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>or</Text>
              <View style={styles.dividerLine} />
            </View>

            <Button
              label="Create an account"
              variant="secondary"
              onPress={() => navigation.navigate('Signup')}
            />
          </View>
      </KeyboardAwareScrollView>
    </SafeAreaView>
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
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: Colors.text3,
    marginHorizontal: 12,
  },
});
