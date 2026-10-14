import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
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
      title="Your adapter"
      subtitle="Check the sizes before you print anything."
      onBack={onBack}
      footer={
        <>
          <Button
            label="Edit measurements"
            variant="secondary"
            onPress={onEdit}
          />
          <Button
            label="Print a fit test"
            disabled
            accessibilityHint="Fit tests are not available yet"
            onPress={() => {}}
          />
        </>
      }
    >
      <Card style={styles.previewCard}>
        <View style={styles.previewHeader}>
          <Text style={type.heading}>Your adapter</Text>
          <View style={styles.statusBadge}>
            <Text style={styles.statusBadgeText}>✓ Ready to print</Text>
          </View>
        </View>
        <MeasurementSketch spec={spec} />
        <Text style={styles.previewNote}>
          The 3D preview will appear here once the geometry is connected.
        </Text>
      </Card>

      <Card>
        <View style={styles.cardHeader}>
          <Text style={type.heading}>Holder fit</Text>
          <Text style={styles.badge}>Protected</Text>
        </View>
        <Text style={type.caption}>
          {evidence > 0
            ? `${evidence} fit test result${
                evidence === 1 ? '' : 's'
              } recorded. Changing these sizes clears ${
                evidence === 1 ? 'it' : 'them'
              }.`
            : 'No fit test yet. Changing these sizes later means a new fit test.'}
        </Text>
        {HOLDER_ROWS.map(k => (
          <DimensionRow key={k} spec={spec} k={k} />
        ))}
      </Card>

      <Card>
        <Text style={type.heading}>Cup</Text>
        <Text style={type.caption}>
          Adjusting the cup width keeps your holder fit. It does not tell you
          how well a different cup will be held.
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
  previewCard: { alignItems: 'center', paddingVertical: space.xl, paddingHorizontal: space.lg },
  previewHeader: {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: space.lg,
    paddingBottom: space.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  statusBadge: {
    backgroundColor: colors.passSoft,
    borderRadius: space.lg,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
  },
  statusBadgeText: {
    ...type.label,
    color: colors.pass,
    fontWeight: '700',
  },
  sketch: { alignItems: 'center', gap: space.sm, marginVertical: space.lg },
  bar: { height: 10, borderRadius: radius.pill },
  cupBar: { backgroundColor: colors.accent, marginBottom: space.md },
  holderBar: { backgroundColor: colors.ink },
  depth: {
    justifyContent: 'center',
    alignItems: 'flex-start',
    borderLeftWidth: 2,
    borderColor: colors.muted,
    paddingLeft: space.md,
    minHeight: 40,
  },
  previewNote: { ...type.caption, textAlign: 'center', marginTop: space.lg, color: colors.muted },
  cardHeader: {
    width: '100%',
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
    gap: space.md,
    paddingVertical: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  rowText: { flex: 1 },
  value: {
    ...type.body,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    minWidth: 72,
    textAlign: 'right',
    color: colors.accent,
  },
  stepper: { flexDirection: 'row', gap: space.xs },
  stepButton: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
  stepPressed: { backgroundColor: colors.accentSoft, borderColor: colors.accent },
  stepDisabled: { opacity: 0.4 },
  stepText: { fontSize: 22, fontWeight: '700', color: colors.ink },
  revision: { ...type.caption, textAlign: 'center', marginTop: space.xl },
  notice: { ...type.caption, color: colors.pending, marginTop: space.md, fontWeight: '500' },
});
