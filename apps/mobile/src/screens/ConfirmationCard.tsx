import React, { useMemo, useState } from 'react';
import { Image, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  confirmationContent,
  confirmationFields,
  initialValues,
  type ConfirmationField,
  type ConfirmationValues,
} from '../printing/confirmationForm';
import type { Confirmation, ConfirmationAnswer } from '../printing/printerHandoff';
import { Button, Card, Field } from '../ui/components';
import { colors, radius, space, type } from '../ui/theme';

/**
 * Whole minutes left, rounded up, before `deadlineMs` on this phone's clock
 * (see confirmationDeadline). Null when only the companion ends the question.
 */
export function minutesLeft(deadlineMs: number | null, now: number) {
  return deadlineMs === null ? null : Math.max(0, Math.ceil((deadlineMs - now) / 60000));
}

/**
 * One question from the printer server, such as "check the bed, then confirm
 * this print". Shows the printer camera's photo when the server sent one.
 * Approve answers with the form's values; Deny declines. Nothing prints
 * until the person approves.
 */
export function ConfirmationCard({
  confirmation,
  deadlineMs,
  now,
  answering,
  onAnswer,
}: {
  confirmation: Confirmation;
  /** When it stops taking answers, on this phone's clock, or null if unknown. */
  deadlineMs: number | null;
  now: number;
  answering: boolean;
  onAnswer: (answer: ConfirmationAnswer) => void;
}) {
  const url = confirmation.mode === 'url' ? safeUrl(confirmation.url) : null;
  // A link question without a safe https link can only be denied here.
  const fields = useMemo(
    () =>
      confirmation.mode === 'form'
        ? confirmationFields(confirmation.requestedSchema)
        : safeUrl(confirmation.url)
        ? []
        : null,
    [confirmation],
  );
  const [values, setValues] = useState<ConfirmationValues>(() => initialValues(fields ?? []));
  const left = minutesLeft(deadlineMs, now);
  const expired = left === 0;
  const [linkFailed, setLinkFailed] = useState(false);
  const result = fields ? confirmationContent(fields, values) : null;
  const set = (key: string, value: ConfirmationValues[string]) =>
    setValues(current => ({ ...current, [key]: value }));

  return (
    <Card style={styles.card}>
      <Text style={styles.eyebrow}>YOUR PRINTER IS ASKING</Text>
      {confirmation.cameraSnapshot ? (
        <Image
          accessibilityLabel="The printer camera, just before this question"
          source={{
            uri: `data:${confirmation.cameraSnapshot.mediaType};base64,${confirmation.cameraSnapshot.base64}`,
          }}
          style={styles.snapshot}
          resizeMode="cover"
        />
      ) : null}
      <Text style={type.body}>{confirmation.message}</Text>
      {url ? <Text style={type.caption}>Opens {url.host}</Text> : null}
      {fields?.map(field => (
        <FieldInput
          key={field.key}
          field={field}
          value={values[field.key]}
          disabled={answering || expired}
          onChange={value => set(field.key, value)}
        />
      ))}
      {fields === null ? (
        <Text style={type.caption}>
          This question needs an answer this app can’t give. Deny it here, or answer it on your
          computer.
        </Text>
      ) : null}
      <Text accessibilityLiveRegion="polite" style={type.caption}>
        {expired
          ? 'This question timed out. Nothing was sent to your printer.'
          : left === null
          ? 'If nobody answers, nothing is sent to your printer.'
          : `Answer within about ${left} min. If nobody answers, nothing is sent to your printer.`}
      </Text>
      {result && 'missing' in result && !expired ? (
        <Text style={type.caption}>{result.missing}</Text>
      ) : null}
      {url ? (
        <>
          {linkFailed ? (
            <Text accessibilityLiveRegion="polite" style={type.caption}>
              The link didn’t open. Deny it here, or answer it on your computer.
            </Text>
          ) : null}
          <Button
            label="Open link"
            disabled={answering || expired}
            onPress={async () => {
              // Accepted only once the link has actually opened.
              try {
                await Linking.openURL(url.href);
              } catch {
                setLinkFailed(true);
                return;
              }
              setLinkFailed(false);
              onAnswer({ action: 'accept', content: {} });
            }}
          />
        </>
      ) : fields ? (
        <Button
          label="Approve"
          disabled={answering || expired || !result || !('content' in result)}
          onPress={() => result && 'content' in result && onAnswer({ action: 'accept', content: result.content })}
        />
      ) : null}
      <Button
        label="Deny"
        variant="secondary"
        disabled={answering || expired}
        onPress={() => onAnswer({ action: 'decline' })}
      />
    </Card>
  );
}

function safeUrl(value?: string) {
  try {
    const url = new URL(value ?? '');
    return url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function FieldInput({
  field,
  value,
  disabled,
  onChange,
}: {
  field: ConfirmationField;
  value: ConfirmationValues[string];
  disabled: boolean;
  onChange: (value: ConfirmationValues[string]) => void;
}) {
  if (field.kind === 'boolean') {
    const checked = value === true;
    return (
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked, disabled }}
        accessibilityLabel={field.title}
        accessibilityHint={field.description}
        disabled={disabled}
        onPress={() => onChange(!checked)}
        style={styles.row}
      >
        <View style={[styles.box, checked && styles.boxChecked]}>
          {checked ? <Text style={styles.tick}>✓</Text> : null}
        </View>
        <Text style={[type.body, styles.grow]}>{field.title}</Text>
      </Pressable>
    );
  }
  if (field.kind === 'choice' || field.kind === 'multi') {
    const multi = field.kind === 'multi';
    const chosen: string[] = multi
      ? ((value as string[] | undefined) ?? [])
      : typeof value === 'string'
      ? [value]
      : [];
    return (
      <View
        style={styles.group}
        accessibilityRole={multi ? undefined : 'radiogroup'}
        accessibilityLabel={field.title}
      >
        <Text style={type.label}>{field.title.toUpperCase()}</Text>
        {field.description ? <Text style={type.caption}>{field.description}</Text> : null}
        {field.options.map(option => {
          const on = chosen.includes(option.value);
          return (
            <Pressable
              key={option.value}
              accessibilityRole={multi ? 'checkbox' : 'radio'}
              accessibilityState={{ checked: on, disabled }}
              accessibilityLabel={option.title}
              disabled={disabled}
              onPress={() =>
                onChange(
                  multi
                    ? on
                      ? chosen.filter(v => v !== option.value)
                      : [...chosen, option.value]
                    : option.value,
                )
              }
              style={[styles.option, on && styles.optionOn]}
            >
              <View style={[multi ? styles.box : styles.dot, on && (multi ? styles.boxChecked : styles.dotOn)]}>
                {multi && on ? <Text style={styles.tick}>✓</Text> : null}
              </View>
              <Text style={[type.body, styles.grow]}>{option.title}</Text>
            </Pressable>
          );
        })}
      </View>
    );
  }
  return (
    <Field
      label={field.title}
      hint={field.description}
      editable={!disabled}
      keyboardType={field.kind === 'number' ? (field.integer ? 'number-pad' : 'decimal-pad') : 'default'}
      value={value === undefined ? '' : String(value)}
      onChangeText={onChange}
      {...(field.kind === 'text' && field.maxLength ? { maxLength: field.maxLength } : {})}
    />
  );
}

const styles = StyleSheet.create({
  card: { borderColor: colors.accent, borderWidth: 2 },
  eyebrow: { ...type.label, color: colors.accent },
  snapshot: {
    width: '100%',
    aspectRatio: 16 / 9,
    borderRadius: radius.md,
    backgroundColor: colors.viewport,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 44 },
  grow: { flex: 1 },
  group: { gap: space.sm },
  box: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.muted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxChecked: { borderColor: colors.accent, backgroundColor: colors.accent },
  tick: { color: colors.accentInk, fontSize: 15, fontWeight: '700', lineHeight: 18 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    minHeight: 44,
  },
  optionOn: { borderColor: colors.accent, borderWidth: 2 },
  dot: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: colors.muted },
  dotOn: { borderColor: colors.accent, borderWidth: 6 },
});
