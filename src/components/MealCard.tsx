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
const IMAGE_HEIGHT = 140;
// A diameter Stephen picked by eye, after two rounds of growing it by area.
const AVATAR_SIZE = 38;

interface MealCardProps {
  meal: Meal | PresetMeal;
  onPress?: () => void;
  subtitle?: string;
  savedAt?: string[]; // store names where this meal is already saved
  selected?: boolean; // shown in multi-select mode
  onView?: () => void; // view button shown in multi-select mode
  warning?: string; // amber badge shown below meta row
  creatorPhotoUrl?: string | null; // creator's face, over the meal photo
  creatorName?: string | null;     // who the face belongs to; drives the initial fallback
  onCreatorPress?: () => void;     // open that creator, the way the byline does
  testID?: string; // stable handle for Maestro flows (meal titles are live data)
}

export default function MealCard({ meal, onPress, subtitle, savedAt, selected, onView, warning, creatorPhotoUrl, creatorName, onCreatorPress, testID }: MealCardProps) {
  const photoUrl = 'photoUrl' in meal ? meal.photoUrl : undefined;
  const ingredientCount = meal.ingredients?.length ?? 0;
  // The face sits on the photo, not in the body, and that is the whole reason it
  // fits. This card is half the screen wide: an avatar beside the byline would
  // take ~30 of the ~150pt the body has, and the byline is the line that wraps
  // first. Over the photo it costs the text nothing.
  const creatorInitial = (creatorName ?? '').replace(/^@/, '').trim().charAt(0).toUpperCase();
  const creatorFace = creatorPhotoUrl ? (
    <Image
      source={{ uri: creatorPhotoUrl }}
      style={styles.avatarImage}
      contentFit="cover"
      recyclingKey={creatorPhotoUrl}
      cachePolicy="memory-disk"
    />
  ) : (
    <View style={[styles.avatarImage, styles.avatarFallback]}>
      <Text style={styles.avatarInitial}>{creatorInitial || '?'}</Text>
    </View>
  );

  return (
    <TouchableOpacity
      style={[styles.card, selected && styles.cardSelected]}
      onPress={onPress}
      activeOpacity={0.8}
      testID={testID}
    >
      {photoUrl ? (
        <Image
          source={{ uri: photoUrl }}
          style={styles.image}
          contentFit="cover"
          // Reuse the decoded bitmap as the FlatList recycles rows instead of
          // accumulating one per scrolled card — bounds memory on long lists
          // and on memory-constrained devices (incl. CI simulators).
          recyclingKey={meal.id}
          cachePolicy="memory-disk"
        />
      ) : (
        <View style={[styles.image, styles.imagePlaceholder]}>
          <Text style={styles.placeholderEmoji}>🍽️</Text>
        </View>
      )}
      {creatorName ? (
        // A Touchable only when there is a creator to open, and nested inside the
        // card's own Touchable on purpose: React Native hands the touch to the
        // innermost responder, so pressing the face opens the creator INSTEAD of
        // the meal. That is the outcome the website needs stopPropagation for.
        onCreatorPress ? (
          <TouchableOpacity
            style={styles.avatarWrap}
            testID="creator-avatar"
            onPress={onCreatorPress}
            activeOpacity={0.7}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel={`View ${creatorName}'s profile`}
          >
            {creatorFace}
          </TouchableOpacity>
        ) : (
          <View style={styles.avatarWrap} testID="creator-avatar">{creatorFace}</View>
        )
      ) : null}
      {onView !== undefined && (
        <View style={styles.checkOverlay}>
          <View style={[styles.checkCircle, selected && styles.checkCircleSelected]}>
            {selected && <Text style={styles.checkMark}>✓</Text>}
          </View>
        </View>
      )}
      <View style={styles.body}>
        <Text style={styles.name} numberOfLines={2}>{meal.name}</Text>
        <View style={styles.meta}>
          {subtitle ? (
            <Text style={styles.metaText} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : (
            <View style={{ flex: 1 }} />
          )}
          {onView && (
            <TouchableOpacity onPress={onView} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={styles.viewBtn}>View</Text>
            </TouchableOpacity>
          )}
        </View>
        {warning && (
          <View style={styles.warningBadge}>
            <Text style={styles.warningText}>⚠ {warning}</Text>
          </View>
        )}
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
  cardSelected: {
    borderColor: Colors.brand,
    backgroundColor: Colors.brandLight,
  },
  image: {
    width: '100%',
    height: IMAGE_HEIGHT,
    backgroundColor: Colors.surface,
  },
  imagePlaceholder: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  placeholderEmoji: { fontSize: 40 },
  checkOverlay: {
    position: 'absolute',
    top: 8,
    left: 8,
  },
  checkCircle: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: '#fff',
    backgroundColor: 'rgba(0,0,0,0.3)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkCircleSelected: {
    backgroundColor: Colors.brand,
    borderColor: Colors.brand,
  },
  checkMark: { fontSize: 12, color: '#fff', fontFamily: 'Inter_700Bold' },
  // Bottom-left of the photo, which is 140 tall and starts at the card's top.
  avatarWrap: {
    position: 'absolute',
    left: 8,
    top: IMAGE_HEIGHT - 8 - AVATAR_SIZE,
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    borderWidth: 2,
    borderColor: Colors.surfaceRaised,
    overflow: 'hidden',
    backgroundColor: Colors.brand,
  },
  avatarImage: { width: '100%', height: '100%' },
  avatarFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.brand },
  avatarInitial: { fontSize: 13, color: '#fff', fontFamily: 'Inter_600SemiBold' },
  body: { padding: 12 },
  name: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.text1,
    marginBottom: 6,
    lineHeight: 20,
  },
  meta: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  metaText: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    color: Colors.text3,
    flex: 1,
  },
  viewBtn: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.brand,
    marginLeft: 6,
  },
  warningBadge: {
    marginTop: 5,
    backgroundColor: '#fef3c7',
    borderWidth: 1,
    borderColor: '#fde68a',
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  warningText: {
    fontSize: 10,
    fontFamily: 'Inter_500Medium',
    color: '#92400e',
  },
  savedRow: { marginTop: 5, gap: 2 },
  savedText: {
    fontSize: 11,
    fontFamily: 'Inter_500Medium',
    color: Colors.brand,
  },
});
