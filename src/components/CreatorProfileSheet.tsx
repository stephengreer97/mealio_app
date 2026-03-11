import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  ScrollView,
  TouchableOpacity,
  Alert,
  Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { Colors, Radius } from '../constants/colors';
import { Creator, PresetMeal } from '../types';
import { creators, presetMeals as presetMealsApi } from '../lib/api';
import Button from './ui/Button';
import MealDetailSheet from './MealDetailSheet';

const GRID_COLS = 2;
const GRID_GAP = 8;
const SECTION_PADDING = 16;
const CELL_SIZE = (Dimensions.get('window').width - SECTION_PADDING * 2 - GRID_GAP) / GRID_COLS;

interface CreatorProfileSheetProps {
  visible: boolean;
  creator: Creator | null;
  onClose: () => void;
  onFollowChange?: () => void;
  onPressSaveMeal?: (meal: PresetMeal) => void;
}


export default function CreatorProfileSheet({
  visible,
  creator,
  onClose,
  onFollowChange,
  onPressSaveMeal,
}: CreatorProfileSheetProps) {
  const [following, setFollowing] = useState(creator?.isFollowing ?? false);
  const [followLoading, setFollowLoading] = useState(false);
  const [meals, setMeals] = useState<PresetMeal[]>([]);
  const [mealsLoading, setMealsLoading] = useState(false);
  const [pickedMeal, setPickedMeal] = useState<PresetMeal | null>(null);
  const [mealDetailOpen, setMealDetailOpen] = useState(false);
  const [mealLoading, setMealLoading] = useState(false);

  useEffect(() => {
    setFollowing(creator?.isFollowing ?? false);
  }, [creator?.id]);

  useEffect(() => {
    if (visible && creator?.id) {
      loadMeals();
    }
  }, [visible, creator?.id]);

  async function loadMeals() {
    if (!creator) return;
    setMealsLoading(true);
    try {
      const { meals: m, creator: fullCreator } = await creators.getById(creator.id);
      setMeals(m);
    } catch {
      // silently fail — meals list is non-critical
    } finally {
      setMealsLoading(false);
    }
  }

  async function toggleFollow() {
    if (!creator) return;
    setFollowLoading(true);
    try {
      if (following) {
        await creators.unfollow(creator.id);
      } else {
        await creators.follow(creator.id);
      }
      setFollowing((f) => !f);
      onFollowChange?.();
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Could not update follow status');
    } finally {
      setFollowLoading(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose}>
            <Text style={styles.close}>✕</Text>
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.scroll}>
          {/* Profile section */}
          <View style={styles.profileSection}>
            {creator?.photoUrl ? (
              <Image source={{ uri: creator.photoUrl }} style={styles.avatar} contentFit="cover" />
            ) : (
              <View style={[styles.avatar, styles.avatarPlaceholder]}>
                <Text style={styles.avatarInitial}>
                  {creator?.displayName?.[0]?.toUpperCase() ?? '?'}
                </Text>
              </View>
            )}
            <Text style={styles.name}>{creator?.displayName}</Text>
            {creator?.socialHandle && (
              <Text style={styles.handle}>@{creator.socialHandle}</Text>
            )}
            {creator?.bio && <Text style={styles.bio}>{creator.bio}</Text>}

            <View style={styles.stats}>
              <View style={styles.stat}>
                <Text style={styles.statValue}>{creator?.followers ?? 0}</Text>
                <Text style={styles.statLabel}>Followers</Text>
              </View>
              <View style={styles.stat}>
                <Text style={styles.statValue}>{meals.length}</Text>
                <Text style={styles.statLabel}>Meals</Text>
              </View>
            </View>

            <Button
              label={following ? 'Following ✓' : 'Follow'}
              variant={following ? 'secondary' : 'primary'}
              onPress={toggleFollow}
              loading={followLoading}
              style={styles.followBtn}
            />
          </View>

          {/* Meals section */}
          <View style={styles.mealsSection}>
            <Text style={styles.mealsTitle}>Meals by {creator?.displayName}</Text>
            {mealsLoading ? (
              <Text style={styles.loadingText}>Loading meals…</Text>
            ) : meals.length === 0 ? (
              <Text style={styles.emptyText}>No meals yet.</Text>
            ) : (
              <View style={styles.grid}>
                {meals.map((meal) => (
                  <TouchableOpacity
                    key={meal.id}
                    style={styles.gridCell}
                    onPress={async () => {
                      setMealLoading(true);
                      try {
                        const full = await presetMealsApi.getById(meal.id);
                        setPickedMeal(full);
                        setMealDetailOpen(true);
                      } catch {
                        setPickedMeal(meal);
                        setMealDetailOpen(true);
                      } finally {
                        setMealLoading(false);
                      }
                    }}
                    activeOpacity={0.8}
                  >
                    {meal.photoUrl ? (
                      <Image source={{ uri: meal.photoUrl }} style={styles.gridImage} contentFit="cover" />
                    ) : (
                      <View style={[styles.gridImage, styles.gridImagePlaceholder]}>
                        <Text style={styles.gridEmoji}>🍽️</Text>
                      </View>
                    )}
                    <View style={styles.gridLabelOverlay}>
                      <Text style={styles.gridLabel} numberOfLines={2}>{meal.name}</Text>
                    </View>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>
        </ScrollView>

        <MealDetailSheet
          visible={mealDetailOpen}
          meal={pickedMeal}
          mode="view"
          onClose={() => setMealDetailOpen(false)}
          onPressSave={onPressSaveMeal ? () => {
            setMealDetailOpen(false);
            onPressSaveMeal(pickedMeal!);
          } : undefined}
        />
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  header: { padding: 16, alignItems: 'flex-start' },
  close: { fontSize: 20, color: Colors.text3 },
  scroll: { paddingBottom: 40 },
  profileSection: { alignItems: 'center', paddingHorizontal: 24, paddingTop: 8, paddingBottom: 24 },
  avatar: {
    width: 96,
    height: 96,
    borderRadius: 48,
    marginBottom: 14,
    backgroundColor: Colors.surface,
  },
  avatarPlaceholder: {
    backgroundColor: Colors.brand,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarInitial: { fontSize: 38, fontFamily: 'Inter_700Bold', color: '#fff' },
  name: { fontSize: 22, fontFamily: 'Inter_700Bold', color: Colors.text1, marginBottom: 4 },
  handle: { fontSize: 14, fontFamily: 'Inter_400Regular', color: Colors.text3, marginBottom: 10 },
  bio: {
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
    color: Colors.text2,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 20,
  },
  stats: { flexDirection: 'row', gap: 40, marginBottom: 20 },
  stat: { alignItems: 'center' },
  statValue: { fontSize: 22, fontFamily: 'Inter_700Bold', color: Colors.text1 },
  statLabel: { fontSize: 13, fontFamily: 'Inter_400Regular', color: Colors.text3, marginTop: 2 },
  followBtn: { width: 200 },
  mealsSection: {
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    paddingHorizontal: 16,
    paddingTop: 20,
  },
  mealsTitle: { fontSize: 16, fontFamily: 'Inter_700Bold', color: Colors.text1, marginBottom: 14 },
  loadingText: { fontSize: 14, fontFamily: 'Inter_400Regular', color: Colors.text3, textAlign: 'center', paddingVertical: 20 },
  emptyText: { fontSize: 14, fontFamily: 'Inter_400Regular', color: Colors.text3, textAlign: 'center', paddingVertical: 20 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GRID_GAP },
  gridCell: { width: CELL_SIZE, height: CELL_SIZE, borderRadius: Radius.card, overflow: 'hidden' },
  gridImage: { width: '100%', height: '100%', backgroundColor: Colors.surface },
  gridImagePlaceholder: { justifyContent: 'center', alignItems: 'center' },
  gridEmoji: { fontSize: 28 },
  gridLabelOverlay: {
    position: 'absolute',
    bottom: 0, left: 0, right: 0,
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  gridLabel: {
    fontSize: 13,
    fontFamily: 'Inter_500Medium',
    color: '#fff',
    lineHeight: 17,
  },
});
