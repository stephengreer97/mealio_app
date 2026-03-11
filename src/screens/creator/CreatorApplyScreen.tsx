import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Alert,
  TouchableOpacity,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-aware-scroll-view';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { Image } from 'expo-image';
import { Colors, Radius } from '../../constants/colors';
import { creators as creatorsApi, images as imagesApi } from '../../lib/api';
import { CreatorApplication } from '../../types';
import Input from '../../components/ui/Input';
import Button from '../../components/ui/Button';
import Card from '../../components/ui/Card';

type State = 'loading' | 'form' | 'pending';

export default function CreatorApplyScreen() {
  const [state, setState] = useState<State>('loading');
  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [findUs, setFindUs] = useState('');
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    checkStatus();
  }, []);

  async function checkStatus() {
    try {
      const { creator, application } = await creatorsApi.getMe();
      if (creator) {
        // Shouldn't happen (MainTabs handles this), but just in case
        setState('form');
      } else if (application?.status === 'pending') {
        setState('pending');
      } else {
        setState('form');
      }
    } catch {
      setState('form');
    }
  }

  async function handlePickPhoto() {
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
        setPhotoUrl(url);
      } catch (err: any) {
        Alert.alert('Error', err.message || 'Could not upload photo');
      } finally {
        setUploading(false);
      }
    }
  }

  function validate() {
    const e: Record<string, string> = {};
    if (!displayName.trim()) e.displayName = 'Display name is required';
    if (!phone.trim()) e.phone = 'Phone number is required';
    if (!findUs.trim()) e.findUs = 'Please tell us how you found us';
    if (!termsAccepted) e.terms = 'You must accept the terms';
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleSubmit() {
    if (!validate()) return;
    setSubmitting(true);
    try {
      await creatorsApi.apply({
        displayName: displayName.trim(),
        phone: phone.trim(),
        findUs: findUs.trim(),
        photoUrl: photoUrl ?? undefined,
      });
      setState('pending');
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Could not submit application');
    } finally {
      setSubmitting(false);
    }
  }

  if (state === 'loading') {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.centered}>
          <Text style={styles.loadingText}>Loading...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (state === 'pending') {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.centered}>
          <Text style={styles.icon}>⏳</Text>
          <Text style={styles.title}>Application Under Review</Text>
          <Text style={styles.subtitle}>
            We're reviewing your creator application. We'll reach out within 3-5 business days.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAwareScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" enableOnAndroid extraScrollHeight={24}>
          <Text style={styles.title}>Become a Creator</Text>
          <Text style={styles.subtitle}>
            Share your meals with the Mealio community and earn a share of subscription revenue.
          </Text>

          <Card style={styles.card}>
            <Input
              label="Display Name"
              placeholder="Your creator name"
              value={displayName}
              onChangeText={setDisplayName}
              error={errors.displayName}
            />
            <Input
              label="Phone Number"
              placeholder="+1 (555) 000-0000"
              value={phone}
              onChangeText={setPhone}
              keyboardType="phone-pad"
              error={errors.phone}
            />
            <Input
              label="How did you find us?"
              placeholder="Instagram handle, YouTube, etc."
              value={findUs}
              onChangeText={setFindUs}
              error={errors.findUs}
            />

            <Text style={styles.photoLabel}>Profile Photo (optional)</Text>
            <View style={styles.photoRow}>
              {photoUrl ? (
                <Image source={{ uri: photoUrl }} style={styles.photo} contentFit="cover" />
              ) : (
                <View style={[styles.photo, styles.photoPlaceholder]}>
                  <Text style={styles.photoPlaceholderText}>📷</Text>
                </View>
              )}
              <Button
                label={uploading ? 'Uploading...' : photoUrl ? 'Change Photo' : 'Add Photo'}
                variant="secondary"
                size="sm"
                onPress={handlePickPhoto}
                loading={uploading}
                style={styles.photoBtn}
              />
            </View>

            <TouchableOpacity style={styles.termsRow} onPress={() => setTermsAccepted((v) => !v)}>
              <View style={[styles.checkbox, termsAccepted && styles.checkboxChecked]}>
                {termsAccepted && <Text style={styles.checkmark}>✓</Text>}
              </View>
              <Text style={styles.termsText}>
                I agree to the Mealio Creator Terms and understand the revenue share model
              </Text>
            </TouchableOpacity>
            {errors.terms && <Text style={styles.errorText}>{errors.terms}</Text>}
          </Card>

          <Button
            label="Submit Application"
            onPress={handleSubmit}
            loading={submitting}
            style={styles.submitBtn}
          />
      </KeyboardAwareScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  scroll: { padding: 16, paddingBottom: 40 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40 },
  loadingText: { fontSize: 16, color: Colors.text3, fontFamily: 'Inter_400Regular' },
  icon: { fontSize: 56, marginBottom: 16, textAlign: 'center' },
  title: { fontSize: 26, fontFamily: 'Inter_700Bold', color: Colors.text1, marginBottom: 8 },
  subtitle: {
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
    color: Colors.text2,
    lineHeight: 22,
    marginBottom: 20,
    textAlign: 'center',
  },
  card: { marginBottom: 16 },
  photoLabel: { fontSize: 14, fontFamily: 'Inter_500Medium', color: Colors.text2, marginBottom: 10 },
  photoRow: { flexDirection: 'row', alignItems: 'center', gap: 16, marginBottom: 20 },
  photo: { width: 72, height: 72, borderRadius: 36, backgroundColor: Colors.surface },
  photoPlaceholder: { justifyContent: 'center', alignItems: 'center' },
  photoPlaceholderText: { fontSize: 28 },
  photoBtn: { flex: 1 },
  termsRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: Colors.border,
    marginTop: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkboxChecked: { backgroundColor: Colors.brand, borderColor: Colors.brand },
  checkmark: { fontSize: 13, color: '#fff', fontFamily: 'Inter_700Bold' },
  termsText: { flex: 1, fontSize: 14, fontFamily: 'Inter_400Regular', color: Colors.text2, lineHeight: 20 },
  errorText: { fontSize: 12, color: Colors.error, marginTop: 4, fontFamily: 'Inter_400Regular' },
  submitBtn: {},
});
