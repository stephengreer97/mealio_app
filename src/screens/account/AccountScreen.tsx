import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  FlatList,
  Linking,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-aware-scroll-view';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Colors, Radius } from '../../constants/colors';
import { useAuth } from '../../context/AuthContext';
import { account as accountApi, creators as creatorsApi, meals as mealsApi, images as imagesApi, payments as paymentsApi } from '../../lib/api';
import { Creator, Meal } from '../../types';
import Card from '../../components/ui/Card';
import Button from '../../components/ui/Button';
import Input from '../../components/ui/Input';

export default function AccountScreen() {
  const { user, isCreator, logout, refreshUser } = useAuth();
  const [following, setFollowing] = useState<Creator[]>([]);
  const [deletedMeals, setDeletedMeals] = useState<Meal[]>([]);

  // Change password state
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [pwLoading, setPwLoading] = useState(false);
  const [pwError, setPwError] = useState('');

  // Subscription
  const [portalLoading, setPortalLoading] = useState(false);

  // Creator photo state
  const [uploading, setUploading] = useState(false);
  const [creatorProfile, setCreatorProfile] = useState<Creator | null>(null);

  useEffect(() => {
    loadFollowing();
    loadDeletedMeals();
    if (isCreator) loadCreatorProfile();
  }, [isCreator]);

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
      await accountApi.changePassword(currentPw, newPw);
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

  async function handleManageSubscription() {
    setPortalLoading(true);
    try {
      const { portalUrl } = await paymentsApi.portal();
      if (portalUrl) await Linking.openURL(portalUrl);
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Could not load billing portal');
    } finally {
      setPortalLoading(false);
    }
  }

  async function handleLogout() {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: logout },
    ]);
  }

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
            <View style={styles.subBadgePaid}>
              <Text style={styles.subBadgeTitlePaid}>Full Access</Text>
              <Text style={styles.subBadgeDesc}>Unlimited saved meals across all stores.</Text>
            </View>
          ) : (
            <View style={styles.subBadgeFree}>
              <Text style={styles.subBadgeTitleFree}>Free Trial</Text>
              <Text style={styles.subBadgeDesc}>Up to 3 saved meals. Upgrade to remove the limit.</Text>
            </View>
          )}
          <Button
            label={portalLoading ? 'Loading…' : 'Manage Subscription'}
            variant="secondary"
            onPress={handleManageSubscription}
            loading={portalLoading}
            style={styles.manageBtn}
          />
          <Text style={styles.subHint}>Update payment method, view billing history, or cancel anytime.</Text>
        </Card>

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

        {/* Sign Out */}
        <Button
          label="Sign Out"
          variant="danger"
          onPress={handleLogout}
          style={styles.signOutBtn}
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
  signOutBtn: { marginTop: 8 },
});
