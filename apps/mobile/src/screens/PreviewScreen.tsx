import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  PLACEHOLDER_DIMENSION_KEYS,
  type PlaceholderCupHolderFitSpec,
  type PlaceholderDimensionKey,
} from '../contracts/placeholder';
import { Button, Card, Screen } from '../ui/components';
import { colors, radius, space, type } from '../ui/theme';

const LABELS: Record<PlaceholderDimensionKey, string> = {
  holderOpening: 'Holder opening',
  holderDepth: 'Holder depth',
  cupBase: 'Cup base',
};

const SOURCE_LABEL = {
  'user-confirmed': 'You entered',
  captured: 'From scan',
} as const;

const DIAGRAM_WIDTH = 240;

/** Input-only sketch of what was measured; the adapter shape is not drawn here. */
function MeasurementSketch({ spec }: { spec: PlaceholderCupHolderFitSpec }) {
  const opening = spec.holderOpening.valueMm;
  const depth = spec.holderDepth.valueMm;
  const cup = spec.cupBase.valueMm;
  const scale = DIAGRAM_WIDTH / Math.max(opening, cup, depth);
  return (
    <View
      style={styles.sketch}
      accessible
      accessibilityLabel={`Sketch: holder ${opening} millimetres wide and ${depth} deep; cup base ${cup} millimetres.`}
    >
      <View style={[styles.cup, { width: cup * scale }]} />
      <Text style={type.caption}>Cup base {cup} mm</Text>
      <View
        style={[
          styles.holder,
          { width: opening * scale, height: depth * scale },
        ]}
      >
        <Text style={styles.holderText}>
          {opening} × {depth} mm
        </Text>
      </View>
    </View>
  );
}

export function PreviewScreen({
  spec,
  onEdit,
  onBack,
}: {
  spec: PlaceholderCupHolderFitSpec;
  onEdit: () => void;
  onBack: () => void;
}) {
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
        <Text style={type.heading}>Measurements</Text>
        {PLACEHOLDER_DIMENSION_KEYS.map(key => {
          const d = spec[key];
          return (
            <View key={key} style={styles.row}>
              <View>
                <Text style={type.body}>{LABELS[key]}</Text>
                <Text style={type.caption}>{SOURCE_LABEL[d.source]}</Text>
              </View>
              <Text style={styles.value}>
                {d.valueMm} mm{' '}
                <Text style={type.caption}>± {d.uncertaintyMm}</Text>
              </Text>
            </View>
          );
        })}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  previewCard: { alignItems: 'center', paddingVertical: space.xl },
  sketch: { alignItems: 'center', gap: space.sm },
  cup: {
    height: 10,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  holder: {
    marginTop: space.sm,
    borderLeftWidth: 3,
    borderRightWidth: 3,
    borderBottomWidth: 3,
    borderColor: colors.ink,
    borderBottomLeftRadius: radius.md,
    borderBottomRightRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 40,
  },
  holderText: { ...type.caption, color: colors.ink },
  previewNote: { ...type.caption, textAlign: 'center', marginTop: space.lg },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  value: { ...type.body, fontWeight: '600', fontVariant: ['tabular-nums'] },
});
