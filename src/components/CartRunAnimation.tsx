import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg';
import { Colors } from '../constants/colors';
import Produce from './CartRunProduce';

// What the user watches while the network rail works.
//
// The rail loads no pages, so there is nothing to look at and nothing to do.
// This fills that space: a brown paper grocery bag, printed in the store's
// colour, that visibly fills as items land — groceries drop in, pile up, and
// start spilling over the rim once it is full enough.
//
// THE LAYERING IS THE WHOLE TRICK. The bag is drawn in two pieces with the
// groceries sandwiched between them: back panel, then produce, then the front
// panel over the top. That is what makes an item read as being IN the bag
// rather than stuck on it — the front panel hides its bottom half. An earlier
// version drew the produce over a single bag shape and everything floated in
// front of it.
//
// Progress is shown three ways, because a number alone is easy to miss: the
// count, how full the bag looks, and the drop that fires on each landing. Every
// one of them is a real figure — the rail knows how many terms it asked for and
// how many landed.

/** Slots around the bag's mouth. Beyond this they stop reading as a quantity. */
const SLOTS = 8;
const STAGE = 190;

interface Props {
  total: number;
  done: number;
  label?: string | null;
  color?: string;
  title?: string | null;
}

export default function CartRunAnimation({ total, done, label, color, title }: Props) {
  const accent = color || Colors.brand;
  // total 0 = working, denominator unknown (the login check, or before the
  // session probe answers). "0/0" reads as broken, so nothing is counted.
  const indeterminate = total <= 0;
  const pct = indeterminate ? 0 : Math.max(0, Math.min(1, done / total));
  const filled = indeterminate ? 0 : Math.max(0, Math.min(SLOTS, Math.round(pct * SLOTS)));

  const bob = useRef(new Animated.Value(0)).current;
  const squash = useRef(new Animated.Value(0)).current;
  const [drop, setDrop] = useState<{ key: number; index: number } | null>(null);
  const lastDone = useRef(done);

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(bob, { toValue: 1, duration: 1900, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(bob, { toValue: 0, duration: 1900, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [bob]);

  // The only motion tied to a real event: one grocery falls per item confirmed,
  // and the bag takes the hit as it lands.
  useEffect(() => {
    if (done <= lastDone.current) { lastDone.current = done; return; }
    lastDone.current = done;
    setDrop({ key: done, index: done });
    squash.setValue(0);
    Animated.sequence([
      Animated.delay(420),
      Animated.timing(squash, { toValue: 1, duration: 100, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.spring(squash, { toValue: 0, friction: 4.5, tension: 130, useNativeDriver: true }),
    ]).start();
  }, [done, squash]);

  const bobY = bob.interpolate({ inputRange: [0, 1], outputRange: [0, -4] });
  const sy = squash.interpolate({ inputRange: [0, 1], outputRange: [1, 0.92] });
  const sx = squash.interpolate({ inputRange: [0, 1], outputRange: [1, 1.06] });

  return (
    <View style={styles.wrap} testID="cart-run-animation">
      <Animated.View style={[styles.stage, { transform: [{ translateY: bobY }, { scaleX: sx }, { scaleY: sy }] }]}>
        <BagBack accent={accent} />

        {/* Sandwiched: above the back panel, below the front. */}
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          {Array.from({ length: filled }).map((_, i) => (
            <PileItem key={i} index={i} />
          ))}
          {drop && <FallingItem key={drop.key} index={drop.index} />}
        </View>

        <BagFront accent={accent} />

        {!indeterminate && (
          <View style={styles.badge} pointerEvents="none">
            <Text testID="cart-run-count" style={[styles.badgeText, { color: accent }]}>
              {done}<Text style={styles.badgeOf}>/{total}</Text>
            </Text>
          </View>
        )}
      </Animated.View>

      <Text style={styles.title}>{title || 'Filling your cart'}</Text>
      {!!label && <Text style={styles.label} numberOfLines={1} testID="cart-run-label">{label}</Text>}
    </View>
  );
}

/** The back wall of the bag. Everything in the bag is drawn over this. */
function BagBack({ accent }: { accent: string }) {
  return (
    <Svg width={STAGE} height={STAGE} viewBox="0 0 190 190" style={StyleSheet.absoluteFill}>
      <Defs>
        <LinearGradient id="paperBack" x1="0" y1="0" x2="1" y2="0">
          <Stop offset="0" stopColor="#A87F52" />
          <Stop offset="1" stopColor="#C09765" />
        </LinearGradient>
      </Defs>
      {/* Slightly wider than the front, so the rim reads as an opening. */}
      <Path d="M46 74 L144 74 L140 168 Q139 174 132 174 L58 174 Q51 174 50 168 Z" fill="url(#paperBack)" />
      <Path d="M46 74 L144 74 L143 86 L47 86 Z" fill="#8F6B45" opacity={0.55} />
    </Svg>
  );
}

/**
 * The front panel, drawn over the groceries — which is what puts them IN the
 * bag. Carries the paper texture and the store's printing.
 */
function BagFront({ accent }: { accent: string }) {
  return (
    <Svg width={STAGE} height={STAGE} viewBox="0 0 190 190" style={StyleSheet.absoluteFill} pointerEvents="none">
      <Defs>
        <LinearGradient id="paper" x1="0" y1="0" x2="1" y2="0">
          <Stop offset="0" stopColor="#C9A272" />
          <Stop offset="0.5" stopColor="#DDB988" />
          <Stop offset="1" stopColor="#BE9463" />
        </LinearGradient>
      </Defs>

      <Path d="M52 92 L138 92 L134 168 Q133 174 126 174 L64 174 Q57 174 56 168 Z" fill="url(#paper)" />
      {/* The rolled rim. */}
      <Path d="M52 92 L138 92 L137 103 L53 103 Z" fill="#B58B5C" />
      {/* Creases — two verticals and the classic side fold. */}
      <Path d="M76 103 L74 174" stroke="#AD8455" strokeWidth="1.4" opacity={0.5} />
      <Path d="M114 103 L116 174" stroke="#AD8455" strokeWidth="1.4" opacity={0.5} />
      <Path d="M95 103 L95 174" stroke="#B78F60" strokeWidth="1" opacity={0.35} />

      {/* The store's printing. Deliberately illegible — bars, not letters: a
          real wordmark would be a brand we do not own, and a fake one reads as a
          typo. The store's colour is what carries the association. */}
      <Rect x="68" y="118" width="54" height="7" rx="3.5" fill={accent} opacity={0.85} />
      <Rect x="68" y="130" width="34" height="5" rx="2.5" fill={accent} opacity={0.5} />
      <Rect x="106" y="130" width="16" height="5" rx="2.5" fill={accent} opacity={0.3} />
      <Rect x="68" y="141" width="44" height="4" rx="2" fill={accent} opacity={0.22} />
      {/* A band low on the bag, so the colour reads even when the print is small. */}
      <Rect x="56" y="158" width="78" height="6" rx="3" fill={accent} opacity={0.28} />
    </Svg>
  );
}

/**
 * One grocery resting in the bag.
 *
 * Later slots sit higher and further out — that is the "spilling over" as it
 * fills. The first few are tucked down behind the rim; the last ones lean out
 * past the edge.
 */
function PileItem({ index }: { index: number }) {
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(a, { toValue: 1, friction: 5, tension: 150, useNativeDriver: true }).start();
  }, [a]);

  const row = index < 4 ? 0 : 1;
  const col = index % 4;
  // Row 0 nestles inside the rim. Row 1 rides above it and spreads wider, so a
  // full bag looks overloaded rather than merely occupied.
  const left = row === 0 ? 60 + col * 22 : 50 + col * 27;
  const bottom = row === 0 ? 96 : 112;
  const tilt = [-14, 8, -6, 15][col] + (row === 1 ? (col % 2 ? 10 : -10) : 0);

  const scale = a.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] });
  const ty = a.interpolate({ inputRange: [0, 1], outputRange: [14, 0] });

  return (
    <Animated.View
      testID="pile-item"
      style={[
        styles.pileItem,
        { left, bottom, opacity: a, transform: [{ translateY: ty }, { scale }, { rotate: `${tilt}deg` }] },
      ]}
    >
      <Produce index={index} size={row === 1 ? 24 : 27} />
    </Animated.View>
  );
}

/** The grocery for the item that just landed, dropping into the bag. */
function FallingItem({ index }: { index: number }) {
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(t, { toValue: 1, duration: 540, easing: Easing.in(Easing.quad), useNativeDriver: true }).start();
  }, [t]);
  const translateY = t.interpolate({ inputRange: [0, 1], outputRange: [-58, 30] });
  const rotate = t.interpolate({ inputRange: [0, 1], outputRange: ['-30deg', '20deg'] });
  // Gone by the time it reaches the rim, so it reads as dropping INTO the bag
  // rather than sliding behind it.
  const opacity = t.interpolate({ inputRange: [0, 0.72, 1], outputRange: [1, 1, 0] });
  return (
    <Animated.View
      style={[styles.falling, { opacity, transform: [{ translateY }, { rotate }] }]}
      pointerEvents="none"
    >
      <Produce index={index} size={28} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  stage: { width: STAGE, height: STAGE, alignItems: 'center', justifyContent: 'center' },
  pileItem: { position: 'absolute' },
  falling: { position: 'absolute', left: 81, top: 40 },
  badge: {
    position: 'absolute', bottom: 4,
    backgroundColor: Colors.surface, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 4,
    borderWidth: 1, borderColor: Colors.border,
  },
  badgeText: { fontSize: 16, fontFamily: 'Inter_600SemiBold' },
  badgeOf: { fontSize: 13, color: Colors.text3, fontFamily: 'Inter_400Regular' },
  title: { marginTop: 14, fontSize: 17, fontFamily: 'Inter_600SemiBold', color: Colors.text1 },
  label: { marginTop: 6, fontSize: 13, color: Colors.text3, fontFamily: 'Inter_400Regular', textAlign: 'center' },
});
