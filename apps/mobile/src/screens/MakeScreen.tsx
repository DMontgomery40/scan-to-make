import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Button, Field, Screen } from '../ui/components';
import { colors, radius, space, type } from '../ui/theme';

export type MakeKind = 'stand' | 'tray' | 'cup-adapter' | 'custom';
/** The user's choice and words, kept for the design planner. */
export type MakeIdea = { kind: MakeKind; notes: string };

const OPTIONS: {
  kind: MakeKind;
  title: string;
  body: string;
  notesLabel: string;
  placeholder: string;
}[] = [
  {
    kind: 'stand',
    title: 'Stand or cradle',
    body: 'Holds it upright or at an angle, shaped around its outline.',
    notesLabel: 'Anything we should know? (optional)',
    placeholder: 'Tilted back a little, with room for the cable',
  },
  {
    kind: 'tray',
    title: 'Drawer tray',
    body: 'A drawer insert with a pocket that fits it.',
    notesLabel: 'Anything we should know? (optional)',
    placeholder: 'A pocket for the case and a slot for two cables',
  },
  {
    kind: 'cup-adapter',
    title: 'Cup holder adapter',
    body: 'Lets it sit securely in a car or desk cup holder.',
    notesLabel: 'Anything we should know? (optional)',
    placeholder: 'For the round cup holder in my car',
  },
  {
    kind: 'custom',
    title: 'Something else',
    body: 'Describe your own idea in a few words.',
    notesLabel: 'Describe what you’d like to make',
    placeholder: 'A clip that holds it under the edge of my desk',
  },
];

function Glyph({ kind, selected }: { kind: MakeKind; selected: boolean }) {
  const tint = selected ? colors.accent : colors.stoneStroke;
  return (
    <View style={styles.glyph} importantForAccessibility="no-hide-descendants">
      {kind === 'stand' ? (
        <>
          <View style={[styles.standBack, { borderColor: tint }]} />
          <View style={[styles.standBase, { backgroundColor: tint }]} />
        </>
      ) : kind === 'tray' ? (
        <View style={[styles.tray, { borderColor: tint }]}>
          <View style={[styles.trayPocket, { borderColor: tint }]} />
        </View>
      ) : kind === 'cup-adapter' ? (
        <View style={[styles.ring, { borderColor: tint }]} />
      ) : (
        <Text style={[styles.plus, { color: tint }]}>+</Text>
      )}
    </View>
  );
}

export function MakeScreen({
  idea,
  onChange,
  onBack,
}: {
  idea: MakeIdea | null;
  onChange: (idea: MakeIdea) => void;
  onBack: () => void;
}) {
  const [touched, setTouched] = useState(false);
  const selected = OPTIONS.find(o => o.kind === idea?.kind) ?? null;
  const missing =
    idea?.kind === 'custom' && !idea.notes.trim() && touched
      ? 'Describe your idea in a few words.'
      : null;
  return (
    <Screen
      title="What should we make?"
      eyebrow="YOUR SCAN / MAKE"
      subtitle="Pick a starting point, or describe your own idea."
      onBack={onBack}
      footer={
        <>
          <Text style={type.caption}>Design generation is coming soon.</Text>
          <Button
            label="Create design"
            disabled
            accessibilityHint="Design generation is coming soon"
            onPress={() => {}}
          />
        </>
      }
    >
      <View accessibilityRole="radiogroup" style={styles.options}>
        {OPTIONS.map(option => {
          const chosen = option.kind === idea?.kind;
          return (
            <Pressable
              key={option.kind}
              accessibilityRole="radio"
              accessibilityState={{ checked: chosen }}
              accessibilityLabel={option.title}
              accessibilityHint={option.body}
              onPress={() =>
                onChange({ kind: option.kind, notes: idea?.notes ?? '' })
              }
              style={({ pressed }) => [
                styles.option,
                chosen && styles.optionChosen,
                pressed && styles.pressed,
              ]}
            >
              <Glyph kind={option.kind} selected={chosen} />
              <View style={styles.optionText}>
                <Text style={styles.optionTitle}>{option.title}</Text>
                <Text style={type.caption}>{option.body}</Text>
              </View>
              <View style={[styles.radio, chosen && styles.radioChosen]}>
                {chosen ? <View style={styles.radioDot} /> : null}
              </View>
            </Pressable>
          );
        })}
      </View>

      {selected && idea ? (
        <Field
          label={selected.notesLabel}
          value={idea.notes}
          onChangeText={notes => onChange({ ...idea, notes })}
          onBlur={() => setTouched(true)}
          placeholder={selected.placeholder}
          multiline
          maxLength={1200}
          textAlignVertical="top"
          style={styles.notes}
          error={missing}
        />
      ) : null}

      <View
        style={styles.preview}
        accessible
        accessibilityLabel="Design preview. Design generation is coming soon. Nothing has been designed yet."
      >
        <View style={styles.previewArt}>
          <View style={styles.previewObject} />
          <View style={styles.previewPart} />
        </View>
        <Text style={type.label}>DESIGN PREVIEW</Text>
        <Text style={type.heading}>Coming soon</Text>
        <Text style={type.body}>
          When design generation is ready, your design will appear here, shaped
          to fit your scan. You’ll check it before anything is printed.
        </Text>
        <Text style={type.caption}>Nothing has been designed yet.</Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  options: { gap: space.sm },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 72,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  optionChosen: {
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
  },
  pressed: { opacity: 0.75 },
  optionText: { flex: 1, gap: 2 },
  optionTitle: { ...type.body, fontWeight: '600' },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioChosen: { borderColor: colors.accent },
  radioDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.accent,
  },
  glyph: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: colors.stone,
    alignItems: 'center',
    justifyContent: 'center',
  },
  standBack: {
    position: 'absolute',
    left: 15,
    top: 10,
    width: 14,
    height: 24,
    borderWidth: 3,
    borderRadius: 4,
    transform: [{ rotate: '-14deg' }],
  },
  standBase: {
    position: 'absolute',
    left: 10,
    bottom: 11,
    width: 28,
    height: 4,
    borderRadius: 2,
  },
  tray: {
    width: 32,
    height: 22,
    borderWidth: 3,
    borderRadius: 5,
    padding: 3,
  },
  trayPocket: { flex: 0.6, borderWidth: 2, borderRadius: 3 },
  ring: { width: 26, height: 26, borderRadius: 13, borderWidth: 5 },
  plus: { fontSize: 26, lineHeight: 30, fontWeight: '500' },
  notes: { minHeight: 96 },
  preview: {
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: colors.sageStroke,
    backgroundColor: colors.sage,
    padding: space.xl,
    gap: space.sm,
  },
  previewArt: {
    height: 96,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.sm,
  },
  previewObject: {
    width: 64,
    height: 44,
    borderRadius: 14,
    backgroundColor: colors.sageLine,
  },
  previewPart: {
    position: 'absolute',
    width: 96,
    height: 64,
    borderRadius: 20,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: colors.sageStroke,
  },
});
