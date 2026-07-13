import React, { useState, useEffect } from 'react';
import { View, StyleProp, ViewStyle } from 'react-native';
import { Image } from 'expo-image';

interface Props {
  uri: string | null;
  wrapStyle: StyleProp<ViewStyle>;
  imageStyle: any;
}

/**
 * Floating product-preview thumbnail shared by the Choose Product flows. Renders
 * NOTHING (frame included) when there is no image URL or the image fails to load —
 * so a product without a photo shows no preview at all, rather than a blank framed
 * box or the previously selected product's image (which expo-image would otherwise
 * retain across a failed load). The `key` + reset give each product a clean load
 * with no carryover from the prior one.
 */
export default function FloatingPreviewImage({ uri, wrapStyle, imageStyle }: Props) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [uri]);

  if (!uri || failed) return null;

  return (
    <View style={wrapStyle} pointerEvents="none">
      <Image
        key={uri}
        source={{ uri }}
        style={imageStyle}
        contentFit="contain"
        onError={() => setFailed(true)}
      />
    </View>
  );
}
