import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { FitSpec, FitSpecPatch } from '@scan-to-make/contracts';
import { nativeCaptureSource } from '../capture/captureSource';
import { StaleRevisionError } from '../project/fitSpecStore';
import {
  isUserMeasured,
  MEASURED_KEYS,
  measurementError,
  planMeasurements,
  toolForDimension,
  TOOL_UNCERTAINTY_MM,
  type MeasuredKey,
  type MeasuringTool,
} from '../fit/fitDraft';
import { Button, Card, Screen } from '../ui/components';
import { colors, radius, space, type } from '../ui/theme';

const FIELDS: Record<MeasuredKey, { label: string; hint: string }> = {
  holderInnerTopDiameter: {
    label: 'Holder top',
    hint: 'Inside width across the top edge of the holder.',
  },
  holderInnerBottomDiameter: {
    label: 'Holder bottom',
    hint: 'Inside width near the floor. Often a little smaller than the top.',
  },
  insertionDepth: {
    label: 'Holder depth',
    hint: 'How far down the adapter can sit inside the holder.',
  },
  cupOuterDiameter: {
    label: 'Cup width',
    hint: 'Widest part of the cup or bottle that needs to fit.',
  },
};

const TOOLS: { tool: MeasuringTool; label: string }[] = [
  { tool: 'ruler', label: `Ruler · ±${TOOL_UNCERTAINTY_MM.ruler} mm` },
  { tool: 'calipers', label: `Calipers · ±${TOOL_UNCERTAINTY_MM.calipers} mm` },
];

type ArStatus = 'checking' | 'available' | 'unavailable';

function parseMm(text: string): number {
  const trimmed = text.trim().replace(',', '.');
  return trimmed === '' ? Number.NaN : Number(trimmed);
}

function initialText(spec: FitSpec): Record<MeasuredKey, string> {
  const text = {} as Record<MeasuredKey, string>;
  for (const key of MEASURED_KEYS) {
    const d = spec.dimensions[key];
    text[key] = isUserMeasured(d) ? String(d.nominalMm) : '';
  }
  return text;
}

export function CaptureScreen({
  base,
  saving,
  onBack,
  onSubmit,
}: {
  base: FitSpec;
  saving: boolean;
  onBack: () => void;
  onSubmit: (patch: FitSpecPatch) => Promise<void>;
}) {
  const [arStatus, setArStatus] = useState<ArStatus>('checking');
  const [text, setText] = useState(() => initialText(base));
  const [tool, setTool] = useState<MeasuringTool>(() =>
    isUserMeasured(base.dimensions.holderInnerTopDiameter)
      ? toolForDimension(base.dimensions.holderInnerTopDiameter)
      : 'ruler',
  );
  const [touched, setTouched] = useState<Partial<Record<MeasuredKey, boolean>>>(
    {},
  );
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const native = nativeCaptureSource();
    (native ? native.isSupported() : Promise.resolve(false))
      .catch(() => false)
      .then(ok => {
        if (!cancelled) {
          setArStatus(ok ? 'available' : 'unavailable');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const entries = useMemo(() => {
    const values = {} as Record<MeasuredKey, number>;
    for (const key of MEASURED_KEYS) {
      values[key] = parseMm(text[key]);
    }
    return values;
  }, [text]);
  const errors = MEASURED_KEYS.map(key => measurementError(entries[key], tool));
  const valid = errors.every(e => e === null);

  const confirm = () => {
    setSubmitError(null);
    const plan = planMeasurements(base, entries, tool);
    const apply = async () => {
      try {
        await onSubmit(plan.patch);
      } catch (error) {
        setSubmitError(
          error instanceof StaleRevisionError
            ? 'This project changed since you opened it. Your entries are kept; check them and confirm again.'
            : `These measurements could not be saved. ${
                error instanceof Error ? error.message : ''
              }`.trim(),
        );
      }
    };
    if (plan.clearsFitEvidence) {
      Alert.alert(
        'Change the holder fit?',
        'New holder measurements change how the adapter fits the holder, so your earlier fit test result will be cleared.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Change and clear', style: 'destructive', onPress: apply },
        ],
      );
    } else {
      apply();
    }
  };

  const viewportMessage = {
    checking: 'Checking for AR…',
    available:
      'AR is available on this phone. The live scan view is coming next.',
    unavailable:
      'AR scanning is not available here. Enter the sizes by hand for now.',
  }[arStatus];

  return (
    <Screen
      title="Scan your cup holder"
      subtitle="Then confirm the sizes that matter for a good fit."
      onBack={onBack}
      footer={
        <>
          {submitError ? (
            <Text style={styles.errorText}>{submitError}</Text>
          ) : null}
          <Button
            label="Preview adapter"
            disabled={!valid || saving}
            accessibilityHint={valid ? undefined : 'Enter all four sizes first'}
            onPress={confirm}
          />
        </>
      }
    >
      <View
        style={styles.viewport}
        accessibilityRole="image"
        accessibilityLabel={viewportMessage}
      >
        <View style={styles.reticle} />
        <Text style={styles.viewportText}>{viewportMessage}</Text>
      </View>

      <Card>
        <Text style={type.heading}>Confirm measurements</Text>
        <Text style={type.caption}>
          In millimetres. What did you measure with?
        </Text>
        <View style={styles.segment} accessibilityRole="radiogroup">
          {TOOLS.map(option => {
            const selected = option.tool === tool;
            return (
              <Pressable
                key={option.tool}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                onPress={() => setTool(option.tool)}
                style={[
                  styles.segmentItem,
                  selected && styles.segmentItemSelected,
                ]}
              >
                <Text
                  style={[
                    styles.segmentText,
                    selected && styles.segmentTextSelected,
                  ]}
                >
                  {option.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {MEASURED_KEYS.map((key, index) => {
          const field = FIELDS[key];
          const error = touched[key] ? errors[index] : null;
          return (
            <View key={key} style={styles.field}>
              <Text style={styles.fieldLabel}>{field.label}</Text>
              <View
                style={[styles.inputRow, error ? styles.inputRowError : null]}
              >
                <TextInput
                  accessibilityLabel={`${field.label}, millimetres`}
                  accessibilityHint={field.hint}
                  keyboardType="decimal-pad"
                  inputMode="decimal"
                  returnKeyType="done"
                  value={text[key]}
                  onChangeText={value => setText(t => ({ ...t, [key]: value }))}
                  onBlur={() => setTouched(t => ({ ...t, [key]: true }))}
                  placeholder="0"
                  placeholderTextColor={colors.line}
                  style={styles.input}
                />
                <Text style={styles.unit}>mm</Text>
              </View>
              <Text style={[type.caption, error ? styles.errorText : null]}>
                {error ?? field.hint}
              </Text>
            </View>
          );
        })}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  viewport: {
    height: 220,
    borderRadius: radius.lg,
    backgroundColor: colors.viewport,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
    gap: space.lg,
  },
  reticle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    borderWidth: 2,
    borderColor: colors.viewportInk,
    borderStyle: 'dashed',
    opacity: 0.6,
  },
  viewportText: {
    ...type.caption,
    color: colors.viewportInk,
    textAlign: 'center',
  },
  segment: {
    flexDirection: 'row',
    borderRadius: radius.md,
    backgroundColor: colors.background,
    padding: space.xs,
    gap: space.xs,
    marginTop: space.xs,
  },
  segmentItem: {
    flex: 1,
    minHeight: 48,
    borderRadius: radius.md - 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentItemSelected: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  segmentText: { ...type.caption, fontWeight: '600' },
  segmentTextSelected: { color: colors.ink },
  field: { marginTop: space.md, gap: space.xs },
  fieldLabel: { ...type.body, fontWeight: '600' },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    backgroundColor: colors.background,
  },
  inputRowError: { borderColor: colors.fail },
  input: { flex: 1, minHeight: 48, fontSize: 18, color: colors.ink },
  unit: { ...type.body, color: colors.muted, marginLeft: space.sm },
  errorText: { ...type.caption, color: colors.fail },
});
