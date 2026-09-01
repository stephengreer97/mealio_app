import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';
import { Colors } from '../constants/colors';

// What the user watches while the network rail works.
//
// The rail loads no pages, so there is nothing to look at and nothing for the
// user to do. This is what fills that space: groceries dropping into a bag, one
// per item that lands, and the bag filling up as the run goes.
//
// Progress is shown three ways on purpose, because the count alone is easy to
// miss at a glance: the ring, the number, and the pile of food in the bag. The
// pile is the one people actually read — a bag with eight things in it is
// obviously further along than a bag with two, without reading anything.
//
// Every number here is real. The rail knows how many terms it asked for and how
// many landed, so nothing is a spinner dressed up as progress.

/** The cast. Ordered so consecutive drops look different from each other. */
const FOODS = ['🥕', '🍅', '🥬', '🧀', '🥖', '🥛', '🍎', '🧅', '🥑', '🌶️', '🥦', '🍋'];

const BAG_BODY = 'M20 44 L100 44 L94 116 Q93 126 83 126 L37 126 Q27 126 26 116 Z';
const BAG_FLAP = 'M20 44 L100 44 L100 56 L20 56 Z';
const HANDLE_L = 'M42 44 L42 32 Q42 20 52 20';
const HANDLE_R = 'M78 44 L78 32 Q78 20 68 20';

interface Props {
  /** Items the run intends to add. */
  total: number;
  /** Items confirmed so far. */
  done: number;
  /** What it is working on right now. */
  label?: string | null;
  /** The store's brand colour, so the run looks like the store it runs on. */
  color?: string;
  /** Headline. Defaults to "Filling your cart". */
  title?: string | null;
}

export default function CartRunAnimation({ total, done, label, color, title }: Props) {
  const accent = color || Colors.brand;
  // total 0 means "working, denominator unknown" — the login check, or the beat
  // before the session probe answers. "0 of 0" reads as broken, so the bag just
  // bobs and nothing is counted.
  const indeterminate = total <= 0;
  const pct = indeterminate ? 0 : Math.max(0, Math.min(1, done / total));

  // Up to eight things visibly poking out of the bag. More than that and they
  // stop being distinguishable, and the pile stops reading as a quantity.
  const SLOTS = 8;
  const filled = indeterminate ? 0 : Math.round(pct * SLOTS);

  const bob = useRef(new Animated.Value(0)).current;
  const squash = useRef(new Animated.Value(0)).current;
  const [drop, setDrop] = useState<{ key: number; food: string } | null>(null);
  const lastDone = useRef(done);

  // Idle motion, so a run that is waiting on the network still looks alive. A
  // still frame for eight seconds reads as a hang.
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(bob, { toValue: 1, duration: 1700, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(bob, { toValue: 0, duration: 1700, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [bob]);

  // Each item that lands drops one piece of food into the bag, and the bag takes
  // the hit. This is the only motion tied to real events; everything else is
  // ambient.
  useEffect(() => {
    if (done <= lastDone.current) { lastDone.current = done; return; }
    lastDone.current = done;
    setDrop({ key: done, food: FOODS[done % FOODS.length] });
    squash.setValue(0);
    Animated.sequence([
      Animated.delay(430),
      Animated.timing(squash, { toValue: 1, duration: 110, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.spring(squash, { toValue: 0, friction: 4, tension: 120, useNativeDriver: true }),
    ]).start();
  }, [done, squash]);

  const bobY = bob.interpolate({ inputRange: [0, 1], outputRange: [0, -5] });
  const bagScaleY = squash.interpolate({ inputRange: [0, 1], outputRange: [1, 0.9] });
  const bagScaleX = squash.interpolate({ inputRange: [0, 1], outputRange: [1, 1.07] });

  return (
    <View style={styles.wrap} testID="cart-run-animation">
      <View style={styles.stage}>
        <Sparkles color={accent} />

        {/* The pile. Each slot pops in when progress reaches it. */}
        <View style={styles.pile} pointerEvents="none">
          {Array.from({ length: filled }).map((_, i) => (
            <PileItem key={i} index={i} food={FOODS[i % FOODS.length]} />
          ))}
        </View>

        {drop && <FallingFood key={drop.key} food={drop.food} />}

        <Animated.View style={{ transform: [{ translateY: bobY }, { scaleX: bagScaleX }, { scaleY: bagScaleY }] }}>
          <Svg width={150} height={150} viewBox="0 0 120 150">
            <Defs>
              <LinearGradient id="bag" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={accent} stopOpacity="0.95" />
                <Stop offset="1" stopColor={accent} stopOpacity="0.72" />
              </LinearGradient>
            </Defs>
            <Path d={HANDLE_L} stroke={accent} strokeWidth="5" fill="none" strokeLinecap="round" />
            <Path d={HANDLE_R} stroke={accent} strokeWidth="5" fill="none" strokeLinecap="round" />
            <Path d={BAG_BODY} fill="url(#bag)" />
            <Path d={BAG_FLAP} fill={accent} opacity={0.85} />
          </Svg>
        </Animated.View>

        {!indeterminate && (
          <View style={styles.badge} pointerEvents="none">
            <Text testID="cart-run-count" style={[styles.badgeText, { color: accent }]}>
              {done}<Text style={styles.badgeOf}>/{total}</Text>
            </Text>
          </View>
        )}
      </View>

      <Text style={styles.title}>{title || 'Filling your cart'}</Text>
      {!!label && (
        <Text style={styles.label} numberOfLines={1} testID="cart-run-label">{label}</Text>
      )}
    </View>
  );
}

/** One item in the pile, popping in the moment progress reaches its slot. */
function PileItem({ index, food }: { index: number; food: string }) {
  // Mounted only once its slot is reached, so the pile in the tree IS the
  // progress — nothing invisible sitting there inflating the count.
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(a, { toValue: 1, friction: 5, tension: 140, useNativeDriver: true }).start();
  }, [a]);
  // Staggered across the bag mouth, alternating heights so the pile has a
  // silhouette rather than a straight line.
  const x = 12 + (index % 4) * 24 + (index >= 4 ? 10 : 0);
  const y = index >= 4 ? -10 : 0;
  const scale = a.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });
  const ty = a.interpolate({ inputRange: [0, 1], outputRange: [10, 0] });
  return (
    <Animated.Text
      testID="pile-item"
      style={[
        styles.pileItem,
        { left: x, bottom: 84 + y, opacity: a, transform: [{ scale }, { translateY: ty }] },
      ]}
    >
      {food}
    </Animated.Text>
  );
}

/** The piece of food for the item that just landed, falling into the bag. */
function FallingFood({ food }: { food: string }) {
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(t, { toValue: 1, duration: 560, easing: Easing.in(Easing.quad), useNativeDriver: true }).start();
  }, [t]);
  const translateY = t.interpolate({ inputRange: [0, 1], outputRange: [-70, 26] });
  const rotate = t.interpolate({ inputRange: [0, 1], outputRange: ['-25deg', '18deg'] });
  // Fades right at the end so it reads as going INTO the bag rather than behind it.
  const opacity = t.interpolate({ inputRange: [0, 0.75, 1], outputRange: [1, 1, 0] });
  return (
    <Animated.Text
      style={[styles.falling, { opacity, transform: [{ translateY }, { rotate }] }]}
      pointerEvents="none"
    >
      {food}
    </Animated.Text>
  );
}

/** Ambient motes drifting up behind the bag. Purely decorative. */
function Sparkles({ color }: { color: string }) {
  const motes = useMemo(() => [0, 1, 2, 3].map((i) => ({ key: i, delay: i * 700, x: 18 + i * 32 })), []);
  return (
    <>
      {motes.map((m) => (
        <Mote key={m.key} delay={m.delay} x={m.x} color={color} />
      ))}
    </>
  );
}

function Mote({ delay, x, color }: { delay: number; x: number; color: string }) {
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(t, { toValue: 1, duration: 2800, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(t, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [t, delay]);
  const translateY = t.interpolate({ inputRange: [0, 1], outputRange: [30, -60] });
  const opacity = t.interpolate({ inputRange: [0, 0.2, 0.7, 1], outputRange: [0, 0.5, 0.25, 0] });
  return (
    <Animated.View
      style={[styles.mote, { left: x, backgroundColor: color, opacity, transform: [{ translateY }] }]}
    />
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  stage: { width: 170, height: 170, alignItems: 'center', justifyContent: 'center' },
  pile: { position: 'absolute', left: 10, right: 10, top: 0, bottom: 0 },
  pileItem: { position: 'absolute', fontSize: 20 },
  falling: { position: 'absolute', fontSize: 24, zIndex: 3 },
  mote: { position: 'absolute', bottom: 40, width: 6, height: 6, borderRadius: 3 },
  badge: {
    position: 'absolute', bottom: 6,
    backgroundColor: Colors.surface, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 4,
    borderWidth: 1, borderColor: Colors.border,
  },
  badgeText: { fontSize: 16, fontFamily: 'Inter_600SemiBold' },
  badgeOf: { fontSize: 13, color: Colors.text3, fontFamily: 'Inter_400Regular' },
  title: { marginTop: 16, fontSize: 17, fontFamily: 'Inter_600SemiBold', color: Colors.text1 },
  label: { marginTop: 6, fontSize: 13, color: Colors.text3, fontFamily: 'Inter_400Regular', textAlign: 'center' },
});
