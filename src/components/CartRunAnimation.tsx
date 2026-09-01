import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Path, Stop, G } from 'react-native-svg';
import { Colors } from '../constants/colors';

// What the user watches while the network rail works.
//
// The rail loads no pages, so there is nothing to look at — the WebView is a
// blank rectangle doing nothing, and showing it invites the user to interact
// with a page the run does not need them to touch. This replaces it.
//
// It is also the only progress the run can honestly report. The rail knows how
// many terms it asked for and how many landed, so the ring is a real fraction,
// not a spinner pretending to mean something.

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/** A grocery bag, drawn once. The fill level is clipped to the progress. */
const BAG_PATH =
  'M18 30 L18 74 Q18 82 26 82 L54 82 Q62 82 62 74 L62 30 Z';
const HANDLE_PATH =
  'M30 30 L30 22 Q30 12 40 12 Q50 12 50 22 L50 30';

interface Props {
  /** Items the run intends to add. */
  total: number;
  /** Items confirmed so far. */
  done: number;
  /** What it is working on right now, shown under the bag. */
  label?: string | null;
  /** The store's brand colour, so the run looks like the store it is running on. */
  color?: string;
  /** Headline. Defaults to "Filling your cart". */
  title?: string | null;
}

export default function CartRunAnimation({ total, done, label, color, title }: Props) {
  const accent = color || Colors.brand;
  // total 0 means "working, denominator unknown" — the login check, or the beat
  // before the session probe answers. Showing "0 of 0" there reads as broken, so
  // the ring sweeps instead of filling and the count is omitted.
  const indeterminate = total <= 0;
  const pct = indeterminate ? 0 : Math.max(0, Math.min(1, done / total));

  // Ring geometry. Kept out of render so the dash maths is read once.
  const R = 54;
  const C = 2 * Math.PI * R;

  const progress = useRef(new Animated.Value(0)).current;
  const bob = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0)).current;

  // The ring eases to each new value rather than jumping, so an item landing
  // reads as movement rather than a redraw.
  useEffect(() => {
    Animated.timing(progress, {
      toValue: pct,
      duration: 650,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [pct, progress]);

  // Two ambient loops so the screen is alive while nothing is landing — a still
  // frame for eight seconds reads as a hang.
  useEffect(() => {
    const bobLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(bob, { toValue: 1, duration: 1800, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(bob, { toValue: 0, duration: 1800, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1200, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 1200, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      ]),
    );
    bobLoop.start(); pulseLoop.start();
    return () => { bobLoop.stop(); pulseLoop.stop(); };
  }, [bob, pulse]);

  const sweep = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!indeterminate) return;
    const loop = Animated.loop(
      Animated.timing(sweep, { toValue: 1, duration: 1400, easing: Easing.inOut(Easing.quad), useNativeDriver: false }),
    );
    loop.start();
    return () => loop.stop();
  }, [indeterminate, sweep]);

  const dashOffset = indeterminate
    ? sweep.interpolate({ inputRange: [0, 0.5, 1], outputRange: [C * 0.95, C * 0.55, C * 0.95] })
    : progress.interpolate({ inputRange: [0, 1], outputRange: [C, 0] });
  const bobY = bob.interpolate({ inputRange: [0, 1], outputRange: [0, -6] });
  const haloScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1.06] });
  const haloOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.25, 0.05] });

  // Ingredients drifting up into the bag. Fixed count, staggered, so the motion
  // is continuous without tracking real items — the ring carries the truth.
  const motes = useMemo(
    () => [0, 1, 2, 3, 4].map((i) => ({ key: i, delay: i * 520, x: 14 + i * 13 })),
    [],
  );

  return (
    <View style={styles.wrap} testID="cart-run-animation">
      <View style={styles.stage}>
        <Animated.View
          style={[styles.halo, { backgroundColor: accent, opacity: haloOpacity, transform: [{ scale: haloScale }] }]}
        />
        {motes.map((m) => (
          <Mote key={m.key} delay={m.delay} x={m.x} color={accent} />
        ))}
        <Animated.View style={{ transform: [{ translateY: bobY }] }}>
          <Svg width={140} height={140} viewBox="0 0 120 120">
            <Defs>
              <LinearGradient id="bagFill" x1="0" y1="1" x2="0" y2="0">
                <Stop offset="0" stopColor={accent} stopOpacity="0.9" />
                <Stop offset="1" stopColor={accent} stopOpacity="0.45" />
              </LinearGradient>
            </Defs>

            {/* Track, then the progress arc on top of it. */}
            <Circle cx="60" cy="60" r={R} stroke={Colors.border} strokeWidth="6" fill="none" />
            <AnimatedCircle
              cx="60" cy="60" r={R}
              stroke={accent}
              strokeWidth="6"
              strokeLinecap="round"
              fill="none"
              strokeDasharray={`${C} ${C}`}
              strokeDashoffset={dashOffset}
              // Start the arc at the top rather than at 3 o'clock.
              transform="rotate(-90 60 60)"
            />

            <G>
              <Path d={HANDLE_PATH} stroke={accent} strokeWidth="4" fill="none" strokeLinecap="round" />
              <Path d={BAG_PATH} fill="url(#bagFill)" stroke={accent} strokeWidth="3" strokeLinejoin="round" />
            </G>
          </Svg>
        </Animated.View>

        {!indeterminate && (
          <View style={styles.countWrap} pointerEvents="none">
            <Text style={[styles.count, { color: accent }]}>{done}</Text>
            <Text style={styles.of}>of {total}</Text>
          </View>
        )}
      </View>

      <Text style={styles.title}>{title || 'Filling your cart'}</Text>
      {!!label && (
        <Text style={styles.label} numberOfLines={1} testID="cart-run-label">
          {label}
        </Text>
      )}
    </View>
  );
}

/** One ingredient drifting up and fading, on a loop offset by `delay`. */
function Mote({ delay, x, color }: { delay: number; x: number; color: string }) {
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(t, { toValue: 1, duration: 2600, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(t, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [t, delay]);
  const translateY = t.interpolate({ inputRange: [0, 1], outputRange: [40, -46] });
  const opacity = t.interpolate({ inputRange: [0, 0.15, 0.75, 1], outputRange: [0, 0.85, 0.5, 0] });
  const scale = t.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] });
  return (
    <Animated.View
      style={[
        styles.mote,
        { left: x + 26, backgroundColor: color, opacity, transform: [{ translateY }, { scale }] },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  stage: { width: 160, height: 160, alignItems: 'center', justifyContent: 'center' },
  halo: { position: 'absolute', width: 150, height: 150, borderRadius: 75 },
  mote: { position: 'absolute', bottom: 34, width: 7, height: 7, borderRadius: 4 },
  countWrap: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  count: { fontSize: 30, fontFamily: 'Inter_600SemiBold', lineHeight: 34 },
  of: { fontSize: 12, color: Colors.text3, fontFamily: 'Inter_400Regular', marginTop: -2 },
  title: { marginTop: 18, fontSize: 17, fontFamily: 'Inter_600SemiBold', color: Colors.text1 },
  label: { marginTop: 6, fontSize: 13, color: Colors.text3, fontFamily: 'Inter_400Regular', textAlign: 'center' },
});
