import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Radius } from '../constants/colors';
import { images as imagesApi } from '../lib/api';

interface PhotoPickerProps {
  mealName: string;
  previewUri: string;           // local URI or remote URL to display
  onPhotoReady: (uri: string, isUrl: boolean, base64?: string) => void;
  onClear: () => void;
}

/**
 * Renders "Choose Photo" + "Generate Photo" buttons.
 * Calls onPhotoReady(uri, isUrl, base64?) when a photo is selected/generated.
 *   isUrl=true  → uri is a remote URL (no upload needed at save time)
 *   isUrl=false → base64 provided, uri is local URI (upload needed at save time)
 */
export default function PhotoPicker({ mealName, previewUri, onPhotoReady, onClear }: PhotoPickerProps) {
  const [generating, setGenerating] = useState(false);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [fulls, setFulls] = useState<string[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);

  async function pickFromLibrary() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Allow photo access to upload a meal photo.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [4, 3],
      quality: 0.7,
      base64: true,
    });
    if (!result.canceled && result.assets[0].base64) {
      setThumbs([]);
      setFulls([]);
      setSelectedIdx(null);
      onPhotoReady(
        result.assets[0].uri,
        false,
        `data:image/jpeg;base64,${result.assets[0].base64}`,
      );
    }
  }

  async function generatePhoto() {
    if (!mealName.trim()) {
      Alert.alert('Enter a meal name first', 'We need the meal name to find a photo.');
      return;
    }
    setGenerating(true);
    setThumbs([]);
    setFulls([]);
    setSelectedIdx(null);
    onClear();
    try {
      const data = await imagesApi.generatePhoto(mealName.trim());
      if (data.thumbs?.length) {
        setThumbs(data.thumbs);
        setFulls(data.fulls ?? data.thumbs);
      } else {
        Alert.alert('No photos found', 'Try a different meal name.');
      }
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Could not generate photo.');
    } finally {
      setGenerating(false);
    }
  }

  function selectThumb(i: number) {
    if (selectedIdx === i) {
      setSelectedIdx(null);
      onClear();
    } else {
      setSelectedIdx(i);
      onPhotoReady(fulls[i] ?? thumbs[i], true);
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.btnRow}>
        {previewUri ? (
          <Image source={{ uri: previewUri }} style={styles.preview} contentFit="cover" />
        ) : null}

        <TouchableOpacity style={styles.btn} onPress={pickFromLibrary}>
          <Ionicons name="image-outline" size={16} color={Colors.brand} />
          <Text style={styles.btnText}>{previewUri && !thumbs.length ? 'Change' : 'Choose Photo'}</Text>
        </TouchableOpacity>

        <TouchableOpacity style={[styles.btn, styles.btnGenerate]} onPress={generatePhoto} disabled={generating}>
          {generating ? (
            <ActivityIndicator size="small" color={Colors.brand} />
          ) : (
            <Ionicons name="sparkles-outline" size={16} color={Colors.brand} />
          )}
          <Text style={styles.btnText}>{generating ? 'Generating…' : 'Generate Photo'}</Text>
        </TouchableOpacity>

        {previewUri ? (
          <TouchableOpacity onPress={() => { onClear(); setThumbs([]); setSelectedIdx(null); }}>
            <Ionicons name="close-circle" size={22} color={Colors.text3} />
          </TouchableOpacity>
        ) : null}
      </View>

      {thumbs.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.thumbsScroll}>
          {thumbs.map((t, i) => (
            <TouchableOpacity key={i} onPress={() => selectThumb(i)} style={styles.thumbWrap}>
              <Image
                source={{ uri: t }}
                style={[styles.thumb, selectedIdx === i && styles.thumbSelected]}
                contentFit="cover"
              />
              {selectedIdx === i && (
                <View style={styles.thumbCheck}>
                  <Ionicons name="checkmark-circle" size={22} color={Colors.brand} />
                </View>
              )}
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginBottom: 8 },
  btnRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  preview: { width: 56, height: 56, borderRadius: 8 },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: Radius.input,
    borderWidth: 1,
    borderColor: Colors.brand,
    backgroundColor: Colors.brandLight,
  },
  btnGenerate: { borderStyle: 'dashed' },
  btnText: { fontSize: 13, fontFamily: 'Inter_500Medium', color: Colors.brand },
  thumbsScroll: { marginTop: 10 },
  thumbWrap: { position: 'relative', marginRight: 8 },
  thumb: {
    width: 90,
    height: 68,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  thumbSelected: { borderColor: Colors.brand },
  thumbCheck: {
    position: 'absolute',
    top: 4,
    right: 4,
    backgroundColor: '#fff',
    borderRadius: 12,
  },
});
