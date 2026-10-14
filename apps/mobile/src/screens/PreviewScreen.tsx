import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Dimension, FitSpec } from '@scan-to-make/contracts';
import {
  adjustCupWidth,
  canAdjustCupWidth,
  isPreviewAdjusted,
  isUserMeasured,
  toolForDimension,
  type DimensionKey,
} from '../fit/fitDraft';
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
  onChange,
}: {
  spec: FitSpec;
  onChange: (next: FitSpec) => void;
}) {
  const step = (delta: number) => onChange(adjustCupWidth(spec, delta));
  return (
    <View style={styles.stepper}>
      {[-CUP_STEP_MM, CUP_STEP_MM].map(delta => {
        const enabled = canAdjustCupWidth(spec, delta);
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
            onPress={() => step(delta)}
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
  onChange,
  onEdit,
  onBack,
}: {
  spec: FitSpec;
  onChange: (next: FitSpec) => void;
  onEdit: () => void;
  onBack: () => void;
}) {
  const evidence = spec.interfaces['holder-insert'].fitEvidence.length;
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
        <MeasurementSketch spec={spec} />
        <Text style={styles.previewNote}>
          The 3D adapter preview will appear here once the fit geometry is
          connected.
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
                <Stepper spec={spec} onChange={onChange} />
              ) : undefined
            }
          />
        ))}
      </Card>

      <Text style={[type.caption, styles.revision]}>
        Revision {spec.revision}
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  previewCard: { alignItems: 'center', paddingVertical: space.xl },
  sketch: { alignItems: 'center', gap: space.xs },
  bar: { height: 8, borderRadius: radius.pill },
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
    gap: space.md,
    paddingVertical: space.sm,
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
    width: 44,
    height: 44,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
  stepPressed: { opacity: 0.7 },
  stepDisabled: { opacity: 0.35 },
  stepText: { fontSize: 20, fontWeight: '600', color: colors.ink },
  revision: { textAlign: 'center' },
});
