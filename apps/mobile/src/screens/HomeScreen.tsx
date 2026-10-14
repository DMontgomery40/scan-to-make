import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Button, Card, Screen } from '../ui/components';
import { colors, space, type } from '../ui/theme';

export function HomeScreen({
  onStartScan,
  onOpenSpike,
}: {
  onStartScan: () => void;
  onOpenSpike: () => void;
}) {
  return (
    <Screen
      title="Scan to Make"
      subtitle="Make something that fits the things around you."
    >
      <Card highlight>
        <View style={styles.cardHeader}>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>Ready to start</Text>
          </View>
        </View>
        <Text style={type.label}>FEATURED PROJECT</Text>
        <Text style={type.heading}>Cup holder adapter</Text>
        <Text style={styles.description}>
          Scan your cup holder, confirm three measurements, and get a perfect-fitting adapter that prints right the first time.
        </Text>
        <View style={styles.features}>
          <Text style={styles.feature}>✓ Scan or measure</Text>
          <Text style={styles.feature}>✓ Real-time preview</Text>
          <Text style={styles.feature}>✓ Fit testing</Text>
        </View>
        <View style={styles.action}>
          <Button label="Start" onPress={onStartScan} />
        </View>
      </Card>

      <Card style={styles.devCard}>
        <Text style={type.label}>DEVELOPER</Text>
        <Text style={type.heading}>Capture spike (D004)</Text>
        <Text style={styles.description}>
          Test the AR session: frame rate, thermal state, anchoring stability and Hermes runtime over two minutes.
        </Text>
        <View style={styles.action}>
          <Button
            label="Open spike harness"
            variant="secondary"
            onPress={onOpenSpike}
          />
        </View>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  cardHeader: {
    marginBottom: space.md,
  },
  badge: {
    backgroundColor: colors.accentSoft,
    borderRadius: space.lg,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    alignSelf: 'flex-start',
  },
  badgeText: { ...type.label, color: colors.accent, fontWeight: '700' },
  description: { ...type.body, color: colors.muted, lineHeight: 24 },
  features: { gap: space.xs, marginVertical: space.md },
  feature: {
    ...type.body,
    color: colors.ink,
    fontWeight: '500',
  },
  action: { marginTop: space.lg },
  devCard: { backgroundColor: colors.overlayStrong },
});
