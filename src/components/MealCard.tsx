import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Dimensions,
} from 'react-native';
import { Image } from 'expo-image';
import { Colors, Radius } from '../constants/colors';
import { Meal, PresetMeal } from '../types';

const CARD_WIDTH = Dimensions.get('window').width / 2 - 20;

interface MealCardProps {
  meal: Meal | PresetMeal;
  onPress?: () => void;
  subtitle?: string;
  savedAt?: string[]; // store names where this meal is already saved
}

export default function MealCard({ meal, onPress, subtitle, savedAt }: MealCardProps) {
  const photoUrl = 'photoUrl' in meal ? meal.photoUrl : undefined;
  const ingredientCount = meal.ingredients?.length ?? 0;

  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.8}>
      {photoUrl ? (
        <Image source={{ uri: photoUrl }} style={styles.image} contentFit="cover" />
      ) : (
        <View style={[styles.image, styles.imagePlaceholder]}>
          <Text style={styles.placeholderEmoji}>🍽️</Text>
        </View>
      )}
      <View style={styles.body}>
        <Text style={styles.name} numberOfLines={2}>{meal.name}</Text>
        <View style={styles.meta}>
          <Text style={styles.metaText} numberOfLines={1}>
            {subtitle ?? `${ingredientCount} items`}
          </Text>
        </View>
        {savedAt && savedAt.length > 0 && (
          <View style={styles.savedRow}>
            {savedAt.map((store) => (
              <Text key={store} style={styles.savedText} numberOfLines={1}>
                Saved at {store}
              </Text>
            ))}
          </View>
        )}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    width: CARD_WIDTH,
    backgroundColor: Colors.surfaceRaised,
    borderRadius: Radius.card,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: 'hidden',
    marginBottom: 12,
  },
  image: {
    width: '100%',
    height: 140,
    backgroundColor: Colors.surface,
  },
  imagePlaceholder: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  placeholderEmoji: { fontSize: 40 },
  body: { padding: 12 },
  name: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.text1,
    marginBottom: 6,
    lineHeight: 20,
  },
  meta: { flexDirection: 'row', justifyContent: 'space-between' },
  metaText: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    color: Colors.text3,
  },
  savedRow: { marginTop: 5, gap: 2 },
  savedText: {
    fontSize: 11,
    fontFamily: 'Inter_500Medium',
    color: Colors.brand,
  },
});
