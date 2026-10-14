import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import {
  userConfirmed,
  validatePlaceholderFitSpec,
  type PlaceholderCupHolderFitSpec,
  type PlaceholderDimensionKey,
} from '../contracts/placeholder';
import { nativeCaptureSource } from '../capture/captureSource';
import { Button, Card, Screen } from '../ui/components';
import { colors, radius, space, type } from '../ui/theme';

const FIELDS: { key: PlaceholderDimensionKey; label: string; hint: string }[] =
  [
    {
      key: 'holderOpening',
      label: 'Holder opening',
      hint: 'Inside width across the top of the cup holder.',
    },
    {
      key: 'holderDepth',
      label: 'Holder depth',
      hint: 'From the top edge down to the floor of the holder.',
    },
    {
      key: 'cupBase',
      label: 'Cup base',
      hint: 'Width across the bottom of the cup you want to fit.',
    },
  ];

type ArStatus = 'checking' | 'available' | 'unavailable';

function parseMm(text: string): number {
  const trimmed = text.trim().replace(',', '.');
  return trimmed === '' ? Number.NaN : Number(trimmed);
}

export function CaptureScreen({
  initial,
  onBack,
  onConfirm,
}: {
  initial: PlaceholderCupHolderFitSpec | null;
  onBack: () => void;
  onConfirm: (spec: PlaceholderCupHolderFitSpec) => void;
}) {
  const [arStatus, setArStatus] = useState<ArStatus>('checking');
  const [text, setText] = useState<Record<PlaceholderDimensionKey, string>>({
    holderOpening: initial ? String(initial.holderOpening.valueMm) : '',
    holderDepth: initial ? String(initial.holderDepth.valueMm) : '',
    cupBase: initial ? String(initial.cupBase.valueMm) : '',
  });
  const [touched, setTouched] = useState<
    Partial<Record<PlaceholderDimensionKey, boolean>>
  >({});

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

  const spec: PlaceholderCupHolderFitSpec = useMemo(
    () => ({
      kind: 'cup-holder-adapter',
      holderOpening: userConfirmed(parseMm(text.holderOpening)),
      holderDepth: userConfirmed(parseMm(text.holderDepth)),
      cupBase: userConfirmed(parseMm(text.cupBase)),
    }),
    [text],
  );
  const errors = validatePlaceholderFitSpec(spec);
  const valid = Object.keys(errors).length === 0;

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
        <Button
          label="Preview adapter"
          disabled={!valid}
          accessibilityHint={valid ? undefined : 'Enter all three sizes first'}
          onPress={() => onConfirm(spec)}
        />
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
          In millimetres. A ruler or calipers works.
        </Text>
        {FIELDS.map(field => {
          const error = touched[field.key] ? errors[field.key] : undefined;
          return (
            <View key={field.key} style={styles.field}>
              <Text style={styles.fieldLabel} nativeID={`${field.key}-label`}>
                {field.label}
              </Text>
              <View
                style={[styles.inputRow, error ? styles.inputRowError : null]}
              >
                <TextInput
                  accessibilityLabel={`${field.label}, millimetres`}
                  accessibilityHint={field.hint}
                  keyboardType="decimal-pad"
                  inputMode="decimal"
                  returnKeyType="done"
                  value={text[field.key]}
                  onChangeText={value =>
                    setText(t => ({ ...t, [field.key]: value }))
                  }
                  onBlur={() => setTouched(t => ({ ...t, [field.key]: true }))}
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
  unit: { ...type.body, color: colors.muted },
  errorText: { color: colors.fail },
});
