import React, { useState } from 'react';
import { Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { Button, Card, Screen } from '../ui/components';
import { colors, type } from '../ui/theme';
import {
  briefComplete,
  shareableBrief,
  type ProjectBrief,
} from '../project/projectBrief';

const FIELDS: {
  key: keyof ProjectBrief;
  number: string;
  title: string;
  hint: string;
  placeholder: string;
}[] = [
  {
    key: 'object',
    number: '01',
    title: 'What are you working with?',
    hint: 'Name the object or space you want to improve.',
    placeholder: 'A drawer beside my coffee machine',
  },
  {
    key: 'context',
    number: '02',
    title: 'What’s around it?',
    hint: 'Room to move, nearby objects, openings or anything to avoid.',
    placeholder: 'The drawer is shallow and holds loose filters and scoops.',
  },
  {
    key: 'addition',
    number: '03',
    title: 'What would you like to add?',
    hint: 'Describe the job you want your new part to do.',
    placeholder:
      'An organizer with a place for filters, a scoop and spare parts.',
  },
];
export function BriefScreen({
  brief,
  onChange,
  onBack,
  onReview,
}: {
  brief: ProjectBrief;
  onChange: (brief: ProjectBrief) => void;
  onBack: () => void;
  onReview: () => void;
}) {
  const [touched, setTouched] = useState<
    Partial<Record<keyof ProjectBrief, boolean>>
  >({});
  const ready = briefComplete(brief);
  return (
    <Screen
      title="What could work better?"
      eyebrow="YOUR PROJECT / THE IDEA"
      subtitle="Start with the real thing. Tell us what you want to change."
      onBack={onBack}
      footer={
        <Button
          label="Review brief"
          disabled={!ready}
          accessibilityHint={
            ready
              ? undefined
              : 'Describe your object, surroundings and addition first'
          }
          onPress={onReview}
        />
      }
    >
      {FIELDS.map(field => (
        <View key={field.key} style={styles.field}>
          <View style={styles.fieldHeading}>
            <Text style={styles.number}>{field.number}</Text>
            <Text style={styles.fieldTitle}>{field.title}</Text>
          </View>
          <Text style={type.caption}>{field.hint}</Text>
          <TextInput
            accessibilityLabel={field.title}
            accessibilityHint={field.hint}
            value={brief[field.key]}
            onChangeText={value => onChange({ ...brief, [field.key]: value })}
            onBlur={() => setTouched(t => ({ ...t, [field.key]: true }))}
            placeholder={field.placeholder}
            placeholderTextColor="#697064"
            multiline
            maxLength={1200}
            textAlignVertical="top"
            style={styles.input}
          />
          {touched[field.key] && !brief[field.key].trim() ? (
            <Text style={styles.error}>Add a few words before continuing.</Text>
          ) : null}
        </View>
      ))}
      <Text style={styles.sessionNote}>
        Your brief stays here while the app is open. You can share a copy on the
        next screen.
      </Text>
    </Screen>
  );
}
export function BriefReviewScreen({
  brief,
  onEdit,
  onBack,
  onExample,
}: {
  brief: ProjectBrief;
  onEdit: () => void;
  onBack: () => void;
  onExample: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const share = async () => {
    try {
      setError(null);
      await Share.share({
        title: 'My Scan to Make project',
        message: shareableBrief(brief),
      });
    } catch {
      setError('The share sheet could not open. Try again.');
    }
  };
  return (
    <Screen
      title="Your project brief"
      eyebrow="YOUR PROJECT / READY TO KEEP"
      subtitle="A clear starting point for something that fits."
      onBack={onBack}
      footer={
        <>
          <Button label="Share brief" onPress={share} />
          <Button label="Edit idea" variant="secondary" onPress={onEdit} />
        </>
      }
    >
      <Card style={styles.briefCard}>
        <Text style={styles.briefMark}>↗</Text>
        {FIELDS.map(field => (
          <View key={field.key} style={styles.summaryRow}>
            <Text style={type.label}>
              {
                {
                  object: 'THE OBJECT',
                  context: 'THE SURROUNDINGS',
                  addition: 'THE ADDITION',
                }[field.key]
              }
            </Text>
            <Text style={field.key === 'object' ? type.heading : type.body}>
              {brief[field.key].trim()}
            </Text>
          </View>
        ))}
      </Card>
      <View style={styles.next}>
        <Text style={styles.number}>WHAT’S NEXT</Text>
        <Text style={type.heading}>From an idea to a fitted part.</Text>
        <Text style={type.body}>
          Custom scanning and part creation aren’t available yet. Keep your
          brief, or explore how measurements shape a design with the cup-holder
          example.
        </Text>
        <Button
          label="Explore measured example"
          variant="secondary"
          onPress={onExample}
        />
      </View>
      <Text style={styles.sessionNote}>
        This brief is kept for this session. Share a copy to keep it after
        closing the app.
      </Text>
      {error ? (
        <Text accessibilityLiveRegion="polite" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </Screen>
  );
}
const styles = StyleSheet.create({
  field: { gap: 9 },
  fieldHeading: { flexDirection: 'row', gap: 12, alignItems: 'baseline' },
  number: { ...type.label, color: colors.accent },
  fieldTitle: { ...type.heading, fontSize: 19, flex: 1 },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 18,
    padding: 17,
    minHeight: 112,
    fontSize: 16,
    lineHeight: 23,
    color: colors.ink,
  },
  error: { ...type.caption, color: colors.fail },
  sessionNote: { ...type.caption, paddingHorizontal: 2 },
  briefCard: { padding: 24, gap: 22 },
  briefMark: { fontSize: 36, color: colors.accent },
  summaryRow: { gap: 8 },
  next: { gap: 12, paddingHorizontal: 2 },
});
