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
    hint: 'How far down the part can sit inside the holder.',
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
        'New holder measurements change how the insert fits the holder, so your earlier fit test result will be cleared.',
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
    checking: 'Checking camera support…',
    available:
      'Camera scanning is not ready yet. Use a ruler or calipers for this example.',
    unavailable:
      'Camera scanning is unavailable here. You can still measure by hand.',
  }[arStatus];

  return (
    <Screen
      title="Measure the fit."
      eyebrow="MEASURED EXAMPLE / 01"
      subtitle="Cup holder & cup. Four real sizes to start with."
      onBack={onBack}
      footer={
        <>
          {submitError ? (
            <Text style={styles.errorText}>{submitError}</Text>
          ) : null}
          <Button
            label="Review measurements"
            disabled={!valid || saving}
            accessibilityHint={valid ? undefined : 'Enter all four sizes first'}
            onPress={confirm}
          />
        </>
      }
    >
      <View
        style={styles.guide}
        accessible
        accessibilityLabel="Measure the inside opening, inside base and usable depth of the holder, plus the outside width of your cup."
      >
        <View style={styles.guideDrawing}>
          <View style={styles.holderShape}>
            <Text style={styles.guideLetter}>C</Text>
          </View>
          <Text style={styles.topLabel}>A · OPENING</Text>
          <Text style={styles.bottomLabel}>B · BASE</Text>
          <View style={styles.cupShape}>
            <Text style={styles.guideLetter}>D</Text>
          </View>
        </View>
        <Text style={styles.guideCaption}>
          Measure inside the holder. Outside the cup.
        </Text>
      </View>
      <View style={styles.support}>
        <View style={styles.supportDot} />
        <Text style={styles.supportText}>{viewportMessage}</Text>
      </View>

      <Card>
        <Text style={type.heading}>Your measuring tool</Text>
        <Text style={type.caption}>
          We keep a range around each size, based on your tool.
        </Text>
        <View style={styles.segment} accessibilityRole="radiogroup">
          {TOOLS.map(option => {
            const selected = option.tool === tool;
            return (
              <Pressable
                key={option.tool}
                accessibilityRole="radio"
                accessibilityLabel={option.label}
                accessibilityState={{ checked: selected }}
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
              <View style={styles.fieldHeader}>
                <Text style={styles.fieldLetter}>
                  {['A', 'B', 'C', 'D'][index]}
                </Text>
                <Text style={styles.fieldLabel}>{field.label}</Text>
              </View>
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
                  placeholderTextColor={colors.muted}
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
  guide: {
    backgroundColor: colors.viewport,
    padding: 22,
    borderRadius: 24,
    gap: 18,
  },
  guideDrawing: { height: 128, position: 'relative' },
  holderShape: {
    position: 'absolute',
    left: 22,
    top: 30,
    width: 106,
    height: 76,
    borderWidth: 2,
    borderTopWidth: 0,
    borderColor: '#C5D1BC',
    borderBottomLeftRadius: 18,
    borderBottomRightRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cupShape: {
    position: 'absolute',
    right: 16,
    top: 23,
    width: 76,
    height: 84,
    borderRadius: 24,
    borderWidth: 2,
    borderColor: '#D99870',
    alignItems: 'center',
    justifyContent: 'center',
  },
  guideLetter: { color: '#E2E9D9', fontSize: 18, fontWeight: '500' },
  topLabel: {
    position: 'absolute',
    top: 0,
    left: 22,
    color: '#C5D1BC',
    fontSize: 10,
    letterSpacing: 1.5,
  },
  bottomLabel: {
    position: 'absolute',
    bottom: 0,
    left: 22,
    color: '#C5D1BC',
    fontSize: 10,
    letterSpacing: 1.5,
  },
  guideCaption: { color: '#D1DAC9', fontSize: 13, lineHeight: 19 },
  support: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
    paddingHorizontal: 4,
  },
  supportDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.muted,
    marginTop: 7,
  },
  supportText: { ...type.caption, flex: 1 },
  fieldHeader: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  fieldLetter: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.accent,
    width: 18,
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
  field: { marginTop: 20, gap: 8 },
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
  input: { flex: 1, minHeight: 58, fontSize: 24, color: colors.ink },
  unit: { ...type.body, color: colors.muted, marginLeft: space.sm },
  errorText: { ...type.caption, color: colors.fail },
});
