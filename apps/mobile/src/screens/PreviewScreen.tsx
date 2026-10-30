import React, { useState } from 'react';
import { Share, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Dimension, FitSpec, FitSpecPatch } from '@scan-to-make/contracts';
import {
  canAdjustCupWidth,
  cupWidthPatch,
  isPreviewAdjusted,
  isUserMeasured,
  toolForDimension,
  type DimensionKey,
} from '../fit/fitDraft';
import { StaleRevisionError } from '../project/fitSpecStore';
import { Button, Card, Screen } from '../ui/components';
import { colors, radius, space, type } from '../ui/theme';

const LABELS: Record<DimensionKey, string> = {
  holderInnerTopDiameter: 'Holder top',
  holderInnerBottomDiameter: 'Holder bottom',
  insertionDepth: 'Holder depth',
  wallThickness: 'Wall thickness',
  radialClearance: 'Clearance per side',
  cupOuterDiameter: 'Cup width',
  cupSupportHeight: 'Cup support height',
};

const HOLDER_ROWS: DimensionKey[] = [
  'holderInnerTopDiameter',
  'holderInnerBottomDiameter',
  'insertionDepth',
  'wallThickness',
  'radialClearance',
];
const CUP_ROWS: DimensionKey[] = ['cupOuterDiameter', 'cupSupportHeight'];

const CUP_STEP_MM = 1;
const DIAGRAM_WIDTH = 240;

function sourceLabel(d: Dimension): string {
  if (isUserMeasured(d)) {
    return toolForDimension(d) === 'calipers'
      ? 'You measured · calipers'
      : 'You measured · ruler';
  }
  if (isPreviewAdjusted(d)) {
    return 'Adjusted here';
  }
  return {
    manual: 'Measured',
    scan: 'From scan',
    reference: 'Reference',
    design: 'Template default',
  }[d.source];
}

const mm = (n: number) => `${Number(n.toFixed(2))}`;

/** Input-only sketch of what was measured; the adapter shape is not drawn here. */
function MeasurementSketch({ spec }: { spec: FitSpec }) {
  const d = spec.dimensions;
  const top = d.holderInnerTopDiameter.nominalMm;
  const bottom = d.holderInnerBottomDiameter.nominalMm;
  const depth = d.insertionDepth.nominalMm;
  const cup = d.cupOuterDiameter.nominalMm;
  const scale = DIAGRAM_WIDTH / Math.max(top, bottom, cup, depth);
  return (
    <View
      style={styles.sketch}
      accessible
      accessibilityLabel={`Sketch: cup ${mm(cup)} millimetres wide; holder ${mm(
        top,
      )} at the top, ${mm(bottom)} at the bottom, ${mm(depth)} deep.`}
    >
      <Text style={type.caption}>Cup {mm(cup)} mm</Text>
      <View style={[styles.bar, styles.cupBar, { width: cup * scale }]} />
      <View style={[styles.bar, styles.holderBar, { width: top * scale }]} />
      <View style={[styles.depth, { height: Math.max(24, depth * scale) }]}>
        <Text style={type.caption}>{mm(depth)} mm deep</Text>
      </View>
      <View style={[styles.bar, styles.holderBar, { width: bottom * scale }]} />
      <Text style={type.caption}>
        Holder {mm(top)} → {mm(bottom)} mm
      </Text>
    </View>
  );
}

function DimensionRow({
  spec,
  k,
  trailing,
}: {
  spec: FitSpec;
  k: DimensionKey;
  trailing?: React.ReactNode;
}) {
  const d = spec.dimensions[k];
  return (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text style={type.body}>{LABELS[k]}</Text>
        <Text style={type.caption}>
          {sourceLabel(d)} · {mm(d.lowerMm)}–{mm(d.upperMm)} mm
        </Text>
      </View>
      {trailing}
      <Text style={styles.value}>{mm(d.nominalMm)} mm</Text>
    </View>
  );
}

function Stepper({
  spec,
  disabled,
  onStep,
}: {
  spec: FitSpec;
  disabled: boolean;
  onStep: (deltaMm: number) => void;
}) {
  return (
    <View style={styles.stepper}>
      {[-CUP_STEP_MM, CUP_STEP_MM].map(delta => {
        const enabled = !disabled && canAdjustCupWidth(spec, delta);
        return (
          <Pressable
            key={delta}
            accessibilityRole="button"
            accessibilityLabel={`${
              delta < 0 ? 'Narrower' : 'Wider'
            } cup, ${CUP_STEP_MM} millimetre`}
            accessibilityState={{ disabled: !enabled }}
            disabled={!enabled}
            hitSlop={6}
            onPress={() => onStep(delta)}
            style={({ pressed }) => [
              styles.stepButton,
              pressed && styles.stepPressed,
              !enabled && styles.stepDisabled,
            ]}
          >
            <Text style={styles.stepText}>{delta < 0 ? '−' : '+'}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function PreviewScreen({
  spec,
  saving,
  onPatch,
  onEdit,
  onBack,
}: {
  spec: FitSpec;
  saving: boolean;
  /** Patches are bound to the revision on screen; stale ones are rejected. */
  onPatch: (patch: FitSpecPatch) => Promise<unknown>;
  onEdit: () => void;
  onBack: () => void;
}) {
  const evidence = spec.interfaces['holder-insert'].fitEvidence.length;
  const [notice, setNotice] = useState<string | null>(null);

  const stepCup = async (deltaMm: number) => {
    setNotice(null);
    try {
      await onPatch(cupWidthPatch(spec, deltaMm));
    } catch (error) {
      setNotice(
        error instanceof StaleRevisionError
          ? 'This preview was out of date, so it now shows the latest version. Check it and try again.'
          : 'That change could not be saved.',
      );
    }
  };
  return (
    <Screen
      title="Your design study"
      eyebrow="MEASURED EXAMPLE / 02"
      subtitle="Cup holder & cup. A study of the space your part needs to fit."
      onBack={onBack}
      footer={
        <>
          <Button
            label="Share measurements"
            onPress={async () => {
              try {
                setNotice(null);
                await Share.share({
                  message:
                    'Scan to Make — cup-holder measurement study\n\n' +
                    Object.entries(spec.dimensions)
                      .map(
                        ([key, d]) =>
                          `${LABELS[key as DimensionKey]}: ${mm(
                            d.nominalMm,
                          )} mm (${mm(d.lowerMm)}–${mm(
                            d.upperMm,
                          )} mm; ${sourceLabel(d)})`,
                      )
                      .join('\n') +
                    '\n\nMeasurements only. No printable model or verified fit.',
                });
              } catch {
                setNotice('The share sheet could not open. Try again.');
              }
            }}
          />
          <Button
            label="Edit measurements"
            variant="secondary"
            onPress={onEdit}
          />
        </>
      }
    >
      <Card style={styles.previewCard}>
        <MeasurementSketch spec={spec} />
        <Text style={styles.previewNote}>
          Measurement sketch · not a printable model
        </Text>
      </Card>

      <Card>
        <View style={styles.cardHeader}>
          <Text style={type.heading}>The receiving space</Text>
          <Text style={styles.badge}>Fit-critical</Text>
        </View>
        <Text style={type.caption}>
          {evidence > 0
            ? `${evidence} fit test result${
                evidence === 1 ? '' : 's'
              } recorded. Changing these sizes clears ${
                evidence === 1 ? 'it' : 'them'
              }.`
            : 'These are the inside measurements of your holder. Physical fit still needs to be tested.'}
        </Text>
        {HOLDER_ROWS.map(k => (
          <DimensionRow key={k} spec={spec} k={k} />
        ))}
      </Card>

      <Card>
        <Text style={type.heading}>The object to hold</Text>
        <Text style={type.caption}>
          Explore the cup width in 1 mm steps. Your holder measurements stay the
          same; a new size still needs a real fit check.
        </Text>
        {CUP_ROWS.map(k => (
          <DimensionRow
            key={k}
            spec={spec}
            k={k}
            trailing={
              k === 'cupOuterDiameter' ? (
                <Stepper spec={spec} disabled={saving} onStep={stepCup} />
              ) : undefined
            }
          />
        ))}
        {notice ? (
          <Text accessibilityLiveRegion="polite" style={styles.notice}>
            {notice}
          </Text>
        ) : null}
      </Card>

      <Text style={[type.caption, styles.revision]}>
        Revision {spec.revision}
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  previewCard: {
    alignItems: 'center',
    paddingVertical: 28,
    backgroundColor: colors.sage,
  },
  sketch: { alignItems: 'center', gap: space.xs },
  bar: { height: 6, borderRadius: radius.pill },
  cupBar: { backgroundColor: colors.accent, marginBottom: space.sm },
  holderBar: { backgroundColor: colors.ink },
  depth: {
    justifyContent: 'center',
    borderLeftWidth: 1,
    borderColor: colors.line,
    paddingLeft: space.sm,
  },
  previewNote: { ...type.caption, textAlign: 'center', marginTop: space.lg },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  badge: {
    ...type.label,
    color: colors.accent,
    backgroundColor: colors.accentSoft,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  rowText: { flex: 1 },
  value: {
    ...type.body,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    minWidth: 64,
    textAlign: 'right',
  },
  stepper: { flexDirection: 'row', gap: space.xs },
  stepButton: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
  stepPressed: {
    backgroundColor: colors.accentSoft,
    borderColor: colors.accent,
  },
  stepDisabled: { opacity: 0.35 },
  stepText: { fontSize: 24, fontWeight: '600', color: colors.ink },
  revision: { textAlign: 'center' },
  notice: { ...type.caption, color: colors.pending },
});
