import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Button, Screen } from '../ui/components';
import { colors, type } from '../ui/theme';
import type { ProjectBrief } from '../project/projectBrief';

export function HomeScreen({
  onCompanion,
  onStartScan,
  onNewProject,
  onOpenBrief,
  onAbout,
  brief,
  onProjects,
  onDrawer,
}: {
  onCompanion?: () => void;
  onStartScan: () => void;
  onNewProject: () => void;
  onOpenBrief: () => void;
  onAbout: () => void;
  brief: ProjectBrief | null;
  onProjects: () => void;
  onDrawer: () => void;
}) {
  return (
    <Screen
      title="Make it fit."
      subtitle="Something useful. Made for the things and spaces in your life."
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
          accessibilityLabel="Illustration of an object and the space around it"
        >
          <View style={styles.gridH} />
          <View style={styles.gridV} />
          <View style={styles.outline} />
          <View style={styles.circle} />
          <View style={styles.part} />
          <Text style={styles.artLabel}>OBJECT + SPACE + YOUR IDEA</Text>
        </View>
        <Text style={styles.heroTitle}>Start with what’s around you.</Text>
        <Text style={styles.heroCopy}>
          An awkward gap. A thing without a home. An idea that needs to fit.
        </Text>
        <Button label="Describe a project" onPress={onNewProject} />
      </View>

      <Button
        label="Your saved projects"
        variant="secondary"
        onPress={onProjects}
      />
      {brief ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open brief for ${
            brief.object.trim() || 'Untitled project'
          }`}
          onPress={onOpenBrief}
          style={({ pressed }) => [styles.draft, pressed && styles.pressed]}
        >
          <Text style={type.label}>CURRENT BRIEF</Text>
          <Text style={type.heading} numberOfLines={2}>
            {brief.object.trim() || 'Untitled project'}
          </Text>
          <Text style={type.caption} numberOfLines={2}>
            {brief.addition.trim() || 'Continue describing your idea.'}
          </Text>
          <Text style={styles.link}>Continue project ↗</Text>
        </Pressable>
      ) : null}

      <Button
        label="Explore drawer organizer"
        variant="secondary"
        onPress={onDrawer}
      />
      {onCompanion ? (
        <Button
          label="Connect your companion"
          variant="secondary"
          onPress={onCompanion}
        />
      ) : null}
      <View style={styles.workflow}>
        <Text style={type.label}>FROM REAL LIFE TO SOMETHING USEFUL</Text>
        <View style={styles.steps}>
          {['Scan the space', 'Describe the idea', 'Make it yours'].map(
            (label, i) => (
              <View key={label} style={styles.step}>
                <Text style={styles.stepNumber}>0{i + 1}</Text>
                <Text style={styles.stepLabel}>{label}</Text>
              </View>
            ),
          )}
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open cup-holder example"
        onPress={onStartScan}
        style={({ pressed }) => [styles.example, pressed && styles.pressed]}
      >
        <View style={styles.exampleIcon}>
          <View style={styles.smallRing} />
        </View>
        <View style={styles.exampleText}>
          <Text style={type.label}>EXPLORE A MEASURED EXAMPLE</Text>
          <Text style={styles.exampleTitle}>Cup holder & cup</Text>
          <Text style={type.caption}>
            Four sizes. One clearer picture of fit.
          </Text>
        </View>
        <Text style={styles.arrow}>↗</Text>
      </Pressable>
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
  example: {
    borderTopWidth: 1,
    borderColor: colors.line,
    paddingTop: 20,
    paddingBottom: 14,
    flexDirection: 'row',
    gap: 14,
    alignItems: 'center',
  },
  exampleIcon: {
    width: 48,
    height: 56,
    borderRadius: 14,
    backgroundColor: colors.stone,
    alignItems: 'center',
    justifyContent: 'center',
  },
  smallRing: {
    width: 27,
    height: 27,
    borderRadius: 14,
    borderWidth: 5,
    borderColor: colors.stoneStroke,
  },
  exampleText: { flex: 1, gap: 5 },
  exampleTitle: { ...type.body, fontWeight: '600' },
  arrow: { fontSize: 24, color: colors.ink },
  draft: {
    borderRadius: 20,
    padding: 20,
    backgroundColor: colors.surface,
    gap: 9,
  },
  link: { color: colors.accent, fontWeight: '600', marginTop: 7 },
  pressed: { opacity: 0.7 },
});
