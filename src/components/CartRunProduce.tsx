import React from 'react';
import Svg, { Circle, Ellipse, G, Path, Rect } from 'react-native-svg';

// The groceries. Drawn rather than emoji so they sit in the same visual language
// as the rest of the app and render identically on every device — emoji are a
// different artwork on every OS, and on a brown paper bag they read as stickers.
//
// Each is designed on a 28x28 box with the "heavy" end at the bottom, so a
// tilted one still looks like it is resting in a bag rather than floating.

export const PRODUCE_COUNT = 8;

/** One drawn grocery, chosen by index so the pile is varied but deterministic. */
export default function Produce({ index, size = 26 }: { index: number; size?: number }) {
  const P = [Carrot, Tomato, Leaf, Bread, Milk, Apple, Broccoli, Onion];
  const Item = P[((index % P.length) + P.length) % P.length];
  return (
    <Svg width={size} height={size} viewBox="0 0 28 28">
      <Item />
    </Svg>
  );
}

const Carrot = () => (
  <G>
    <Path d="M14 26 L9.5 11 Q14 8.5 18.5 11 Z" fill="#E8792B" />
    <Path d="M11.6 16 L16.4 16" stroke="#C9611B" strokeWidth="1.1" strokeLinecap="round" />
    <Path d="M12.4 20 L15.6 20" stroke="#C9611B" strokeWidth="1.1" strokeLinecap="round" />
    <Path d="M14 9 L10.5 3.5" stroke="#4E9B4A" strokeWidth="2.4" strokeLinecap="round" />
    <Path d="M14 9 L14 3" stroke="#57A94F" strokeWidth="2.4" strokeLinecap="round" />
    <Path d="M14 9 L17.5 4" stroke="#4E9B4A" strokeWidth="2.4" strokeLinecap="round" />
  </G>
);

const Tomato = () => (
  <G>
    <Circle cx="14" cy="17" r="8.6" fill="#DE3B36" />
    <Path d="M9.4 12.6 Q14 15 18.6 12.6" stroke="#B82F2A" strokeWidth="1" fill="none" opacity={0.6} />
    <Path d="M14 9 L14 6.2" stroke="#3F7F3C" strokeWidth="1.8" strokeLinecap="round" />
    <Path d="M10 9.4 L14 8.4 L18 9.4 L14 11 Z" fill="#4E9B4A" />
  </G>
);

const Leaf = () => (
  <G>
    <Path d="M14 26 Q5 19 7 8 Q15 10 14 26 Z" fill="#4E9B4A" />
    <Path d="M14 26 Q23 19 21 8 Q13 10 14 26 Z" fill="#5CB255" />
    <Path d="M14 25 L14 12" stroke="#3B7A38" strokeWidth="1.1" strokeLinecap="round" />
  </G>
);

const Bread = () => (
  <G>
    <Rect x="5" y="10" width="18" height="13" rx="6" fill="#D9A566" />
    <Path d="M9 13.5 L11.5 11" stroke="#B9834A" strokeWidth="1.3" strokeLinecap="round" />
    <Path d="M13 13.5 L15.5 11" stroke="#B9834A" strokeWidth="1.3" strokeLinecap="round" />
    <Path d="M17 13.5 L19.5 11" stroke="#B9834A" strokeWidth="1.3" strokeLinecap="round" />
  </G>
);

const Milk = () => (
  <G>
    <Path d="M9 11 L19 11 L19 24 Q19 25 18 25 L10 25 Q9 25 9 24 Z" fill="#F2F4F7" />
    <Path d="M9 11 L14 5.5 L19 11 Z" fill="#DCE3EB" />
    <Rect x="10.6" y="15" width="6.8" height="4.6" rx="1" fill="#7FB2E5" />
  </G>
);

const Apple = () => (
  <G>
    <Circle cx="14" cy="17.5" r="8.2" fill="#D8453F" />
    <Path d="M14 9.6 Q13.6 6.4 11.6 5.2" stroke="#6B4A2A" strokeWidth="1.6" fill="none" strokeLinecap="round" />
    <Path d="M14.6 9 Q17.4 7.4 19 8.8 Q17.4 10.6 14.6 9 Z" fill="#4E9B4A" />
    <Path d="M10.6 14.4 Q11.8 12.6 13.4 12.4" stroke="#FFFFFF" strokeWidth="1.2" opacity={0.45} fill="none" strokeLinecap="round" />
  </G>
);

const Broccoli = () => (
  <G>
    <Rect x="12.4" y="16" width="3.2" height="8.6" rx="1.4" fill="#94C089" />
    <Circle cx="10" cy="13" r="4.4" fill="#4E9B4A" />
    <Circle cx="18" cy="13" r="4.4" fill="#4E9B4A" />
    <Circle cx="14" cy="10" r="5" fill="#5CB255" />
  </G>
);

const Onion = () => (
  <G>
    <Ellipse cx="14" cy="17.5" rx="7.6" ry="8" fill="#C9A6D6" />
    <Path d="M14 9.6 L14 25" stroke="#A87FB8" strokeWidth="1" opacity={0.7} />
    <Path d="M9.6 12 Q14 17 9.6 23" stroke="#A87FB8" strokeWidth="1" fill="none" opacity={0.55} />
    <Path d="M18.4 12 Q14 17 18.4 23" stroke="#A87FB8" strokeWidth="1" fill="none" opacity={0.55} />
    <Path d="M14 9.4 L12 6" stroke="#8FAF7E" strokeWidth="1.5" strokeLinecap="round" />
    <Path d="M14 9.4 L16 6" stroke="#8FAF7E" strokeWidth="1.5" strokeLinecap="round" />
  </G>
);
