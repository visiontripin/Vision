import { useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme';

/** Обложка с фолбэком на букву: подписанный URL может истечь или отсутствовать. */
export function Cover({ uri, title, size = 48 }: { uri?: string | null; title: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const radius = Math.round(size * 0.22);

  if (!uri || failed) {
    return (
      <View style={[styles.fallback, { width: size, height: size, borderRadius: radius }]}>
        <Text style={[styles.letter, { fontSize: size * 0.4 }]}>{(title || '?').slice(0, 1).toUpperCase()}</Text>
      </View>
    );
  }

  return (
    <Image
      source={{ uri }}
      style={{ width: size, height: size, borderRadius: radius, backgroundColor: colors.panelAlt }}
      onError={() => setFailed(true)}
    />
  );
}

const styles = StyleSheet.create({
  fallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#2a1a12' },
  letter: { color: colors.accentSoft, fontWeight: '800' },
});
