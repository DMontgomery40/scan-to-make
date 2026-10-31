import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Button, Screen } from '../ui/components';
import { colors, type } from '../ui/theme';

export function HomeScreen({
  onCompanion,
  onAbout,
  onProjects,
}: {
  onCompanion?: () => void;
  onAbout: () => void;
  onProjects: () => void;
}) {
  return (
    <Screen
      title="Scan it true."
      subtitle="LiDAR scans of real objects, cleaned up and true to size."
      accessory={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="About Scan to Make"
          onPress={onAbout}
          style={styles.about}
        >
          <Text style={styles.aboutText}>•••</Text>
        </Pressable>
      }
    >
      <View style={styles.hero}>
        <View
          style={styles.art}
          accessible
          accessibilityLabel="Illustration of an object inside a scan grid"
        >
          <View style={styles.gridH} />
          <View style={styles.gridV} />
          <View style={styles.outline} />
          <View style={styles.circle} />
          <View style={styles.part} />
          <Text style={styles.artLabel}>LIDAR SCAN + CLEANUP</Text>
        </View>
        <Text style={styles.heroTitle}>Start with the object.</Text>
        <Text style={styles.heroCopy}>
          Scan it with your iPhone. Your computer repairs holes and stray
          geometry and checks the size.
        </Text>
        <Button label="Your projects" onPress={onProjects} />
      </View>

      {onCompanion ? (
        <Button
          label="Connect your companion"
          variant="secondary"
          onPress={onCompanion}
        />
      ) : null}
      <View style={styles.workflow}>
        <Text style={type.label}>FROM OBJECT TO CLEAN MESH</Text>
        <View style={styles.steps}>
          {['Scan with LiDAR', 'Add close-ups', 'Clean up the mesh'].map(
            (label, i) => (
              <View key={label} style={styles.step}>
                <Text style={styles.stepNumber}>0{i + 1}</Text>
                <Text style={styles.stepLabel}>{label}</Text>
              </View>
            ),
          )}
        </View>
      </View>
    </Screen>
  );
}
const styles = StyleSheet.create({
  about: {
    width: 48,
    minHeight: 48,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  aboutText: { fontSize: 18, color: colors.ink, letterSpacing: 2 },
  hero: {
    backgroundColor: colors.sage,
    borderRadius: 28,
    padding: 22,
    gap: 14,
  },
  art: { height: 168, overflow: 'hidden', marginBottom: 4 },
  gridH: {
    position: 'absolute',
    top: 82,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: colors.sageLine,
  },
  gridV: {
    position: 'absolute',
    top: 0,
    bottom: 24,
    left: '50%',
    width: 1,
    backgroundColor: colors.sageLine,
  },
  outline: {
    position: 'absolute',
    width: 158,
    height: 120,
    borderWidth: 1,
    borderColor: colors.sageStroke,
    borderRadius: 20,
    left: 26,
    top: 13,
    transform: [{ rotate: '-9deg' }],
  },
  circle: {
    position: 'absolute',
    width: 95,
    height: 95,
    borderRadius: 50,
    backgroundColor: colors.viewport,
    left: 56,
    top: 28,
  },
  part: {
    position: 'absolute',
    width: 92,
    height: 68,
    borderWidth: 16,
    borderColor: '#B54B2C',
    borderRadius: 20,
    left: 134,
    top: 65,
    transform: [{ rotate: '-9deg' }],
  },
  artLabel: {
    ...type.label,
    position: 'absolute',
    bottom: 0,
    fontSize: 9,
    letterSpacing: 1.6,
    color: colors.sageMuted,
  },
  heroTitle: { ...type.heading, fontSize: 24, lineHeight: 29, maxWidth: 240 },
  heroCopy: {
    ...type.body,
    fontSize: 15,
    lineHeight: 22,
    color: colors.sageInk,
    marginBottom: 4,
  },
  workflow: { gap: 16, paddingVertical: 6 },
  steps: { flexDirection: 'row', gap: 14 },
  step: { flex: 1, gap: 7 },
  stepNumber: {
    ...type.caption,
    color: colors.accent,
    fontVariant: ['tabular-nums'],
  },
  stepLabel: {
    fontSize: 14,
    lineHeight: 19,
    fontWeight: '500',
    color: colors.ink,
  },
});
