import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, Alert, Share } from 'react-native';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Feather } from '@expo/vector-icons';
import { Colors, Radius } from '../constants/colors';
import { Creator } from '../types';
import { creators as creatorsApi, images as imagesApi } from '../lib/api';
import Card from './ui/Card';
import Button from './ui/Button';
import { OutlineButton, ui } from './creatorUi';

// ─────────────────────────────────────────────────────────────────────────────
// CreatorProfileCard: who the creator is, on the Settings tab
//
// The web portal's profile card: photo, name, website or social, bio and the
// referral link, with an Edit Profile form in place. The referral link lives
// here rather than on the Meals tab because that is where the web puts it, and
// setting the handle that makes it is part of this form. The handle is
// permanent once saved, which the server enforces and this form says up front.
// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  creator: Creator;
  /** The fields a save changed, so the portal's copy stays in step. */
  onSaved: (changes: Partial<Creator>) => void;
}

export default function CreatorProfileCard({ creator, onSaved }: Props) {
  const [editing, setEditing] = useState(false);
  const [bio, setBio] = useState('');
  const [website, setWebsite] = useState('');
  const [handleInput, setHandleInput] = useState('');
  const [photoPreview, setPhotoPreview] = useState('');
  const [photoData, setPhotoData] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function openEdit() {
    setBio(creator.bio ?? '');
    setWebsite(creator.socialHandle ?? '');
    setHandleInput(creator.handle ?? '');
    setPhotoPreview(creator.photoUrl ?? '');
    setPhotoData(null);
    setError('');
    setEditing(true);
  }

  async function pickPhoto() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Allow photo access to change your profile photo.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
      base64: true,
    });
    if (!result.canceled && result.assets[0]?.base64) {
      setPhotoPreview(result.assets[0].uri);
      setPhotoData(`data:image/jpeg;base64,${result.assets[0].base64}`);
    }
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      let photoUrl: string | undefined;
      if (photoData) photoUrl = (await imagesApi.upload(photoData)).url;
      const body: { bio: string | null; socialHandle: string | null; handle: string | null; photoUrl?: string } = {
        bio: bio.trim() || null,
        socialHandle: website.trim() || null,
        handle: handleInput.trim() || null,
      };
      if (photoUrl !== undefined) body.photoUrl = photoUrl;
      await creatorsApi.updateProfile(body);
      onSaved({
        bio: body.bio,
        socialHandle: body.socialHandle,
        handle: creator.handle || body.handle,
        ...(photoUrl ? { photoUrl } : {}),
      });
      setEditing(false);
    } catch (err: any) {
      setError(err?.body?.error || err?.message || 'Something went wrong. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  const avatar = (uri: string | null | undefined, dashed = false) =>
    uri ? (
      <Image source={{ uri }} style={styles.avatar} contentFit="cover" />
    ) : (
      <View style={[styles.avatar, styles.avatarEmpty, dashed && styles.avatarDashed]}>
        <Feather name="user" size={24} color={Colors.text3} />
      </View>
    );

  if (!editing) {
    return (
      <Card style={styles.card}>
        <View testID="profile-card">
          <View style={styles.row}>
            {avatar(creator.photoUrl)}
            <View style={styles.info}>
              <Text style={ui.eyebrow}>YOUR PROFILE</Text>
              <Text style={ui.title}>{creator.displayName}</Text>
              {!!creator.socialHandle && <Text style={styles.social}>{creator.socialHandle}</Text>}
              {!!creator.bio && <Text style={[ui.body, styles.bio]}>{creator.bio}</Text>}
            </View>
          </View>

          {creator.handle ? (
            <View style={styles.referral} testID="referral-link">
              <Text style={styles.fieldLabel}>YOUR REFERRAL LINK</Text>
              <Text style={styles.referralLink}>mealio.co/{creator.handle}</Text>
              <TouchableOpacity
                style={styles.shareBtn}
                onPress={() =>
                  Share.share({ message: `https://mealio.co/${creator.handle}`, url: `https://mealio.co/${creator.handle}` })
                }
                activeOpacity={0.85}
              >
                <Feather name="share-2" size={14} color="#fff" style={{ marginRight: 6 }} />
                <Text style={styles.shareText}>Share your link</Text>
              </TouchableOpacity>
              <Text style={[ui.hint, styles.top]}>Share this link. New signups from it are credited to you.</Text>
            </View>
          ) : null}

          {!creator.bio && !creator.handle && (
            <Text style={[ui.hint, styles.nudge]}>Add a bio, website, and profile link to make your creator page shine.</Text>
          )}

          <OutlineButton label="Edit Profile" onPress={openEdit} testID="edit-profile" style={styles.editBtn} />
        </View>
      </Card>
    );
  }

  return (
    <Card style={styles.card}>
      <View testID="profile-editor">
        <View style={styles.editHeader}>
          <Text style={ui.title}>Edit Profile</Text>
          <TouchableOpacity onPress={() => { setEditing(false); setError(''); }} accessibilityLabel="Cancel editing">
            <Feather name="x" size={20} color={Colors.text3} />
          </TouchableOpacity>
        </View>

        <TouchableOpacity style={styles.row} onPress={() => { void pickPhoto(); }} activeOpacity={0.8} testID="profile-photo">
          {avatar(photoPreview, true)}
          <View style={styles.info}>
            <Text style={ui.strong}>Profile photo</Text>
            <Text style={ui.hint}>Tap to change</Text>
          </View>
        </TouchableOpacity>

        <Text style={[styles.fieldLabel, styles.top]}>BIO</Text>
        <TextInput
          value={bio}
          onChangeText={setBio}
          multiline
          placeholder="Tell people about yourself and your cooking style…"
          placeholderTextColor={Colors.text3}
          style={[styles.input, styles.textArea]}
          testID="profile-bio"
        />

        <Text style={[styles.fieldLabel, styles.top]}>WEBSITE / SOCIAL</Text>
        <TextInput
          value={website}
          onChangeText={setWebsite}
          placeholder="@yourhandle or https://yoursite.com"
          placeholderTextColor={Colors.text3}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
          testID="profile-social"
        />

        <Text style={[styles.fieldLabel, styles.top]}>REFERRAL LINK</Text>
        {creator.handle ? (
          <>
            <View style={[styles.prefixBox, styles.prefixLocked]}>
              <Text style={styles.prefix}>mealio.co/</Text>
              <Text style={[styles.prefixValue, { color: Colors.text3 }]}>{creator.handle}</Text>
            </View>
            <Text style={[ui.hint, styles.small]}>Your referral link is permanent and can’t be changed.</Text>
          </>
        ) : (
          <>
            <View style={styles.prefixBox}>
              <Text style={styles.prefix}>mealio.co/</Text>
              <TextInput
                value={handleInput}
                onChangeText={(text) => setHandleInput(text.toLowerCase().replace(/[^a-z0-9_-]/g, ''))}
                placeholder="yourhandle"
                placeholderTextColor={Colors.text3}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={30}
                style={styles.prefixInput}
                testID="profile-handle"
              />
            </View>
            <Text style={styles.warning}>
              Permanent once saved, so choose carefully. 3 to 30 characters: letters, numbers, hyphens, underscores.
            </Text>
          </>
        )}

        {!!error && <Text style={[ui.error, styles.top]} testID="profile-error">{error}</Text>}

        <View style={styles.actions}>
          <Button
            label={saving ? 'Saving…' : 'Save Profile'}
            onPress={() => { void save(); }}
            disabled={saving}
            style={styles.flex}
            testID="save-profile"
          />
          <Button label="Cancel" variant="secondary" onPress={() => { setEditing(false); setError(''); }} style={styles.cancel} />
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  info: { flex: 1, minWidth: 0 },
  avatar: { width: 64, height: 64, borderRadius: 32 },
  avatarEmpty: { backgroundColor: Colors.surface, borderWidth: 2, borderColor: Colors.border, alignItems: 'center', justifyContent: 'center' },
  avatarDashed: { borderStyle: 'dashed', borderColor: Colors.borderStrong },
  social: { fontSize: 13, fontFamily: 'Inter_400Regular', color: Colors.text3, marginTop: 2 },
  bio: { marginTop: 6 },
  referral: { marginTop: 14 },
  fieldLabel: { fontSize: 11, fontFamily: 'Inter_700Bold', color: Colors.text3, letterSpacing: 0.5, marginBottom: 6 },
  referralLink: { fontSize: 16, fontFamily: 'Inter_600SemiBold', color: Colors.brand, marginBottom: 10 },
  shareBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.brand,
    borderRadius: Radius.button,
    paddingVertical: 10,
  },
  shareText: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: '#fff' },
  top: { marginTop: 8 },
  small: { marginTop: 4 },
  nudge: { marginTop: 12, borderTopWidth: 1, borderTopColor: Colors.border, paddingTop: 12 },
  editBtn: { marginTop: 14 },
  editHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  input: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.input,
    backgroundColor: Colors.surfaceRaised,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: Colors.text1,
  },
  textArea: { minHeight: 80, textAlignVertical: 'top' },
  prefixBox: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.input,
    backgroundColor: Colors.surfaceRaised,
    overflow: 'hidden',
  },
  prefixLocked: { backgroundColor: Colors.surface },
  prefix: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: Colors.text3,
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderRightWidth: 1,
    borderRightColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  prefixValue: { flex: 1, paddingHorizontal: 10, fontSize: 14, fontFamily: 'Inter_400Regular' },
  prefixInput: { flex: 1, paddingHorizontal: 10, paddingVertical: 10, fontSize: 14, fontFamily: 'Inter_400Regular', color: Colors.text1 },
  warning: { fontSize: 12, fontFamily: 'Inter_600SemiBold', color: Colors.error, marginTop: 4, lineHeight: 17 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 16 },
  flex: { flex: 1 },
  cancel: { paddingHorizontal: 18 },
});
