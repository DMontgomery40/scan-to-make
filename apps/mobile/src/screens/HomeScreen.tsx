import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Button, Card, Screen } from '../ui/components';
import { colors, space, type } from '../ui/theme';

export function HomeScreen({
  onStartScan,
  onOpenSpike,
}: {
  onStartScan: () => void;
  onOpenSpike: () => void;
}) {
  return (
    <Screen
      title="Scan to Make"
      subtitle="Scan objects and their surroundings. Describe an addition. Make something that fits."
    >
      <Text style={styles.copy}>
        Custom scan-and-describe projects are coming. For now, explore a
        measurement example.
      </Text>
      <Card>
        <Text style={type.label}>TRY AN EXAMPLE</Text>
        <Text style={type.heading}>Cup holder adapter</Text>
        <Text style={styles.copy}>
          Enter four measurements for a cup holder and cup, then review their
          sizes in a sketch.
        </Text>
        <View style={styles.action}>
          <Button label="Open cup-holder example" onPress={onStartScan} />
        </View>
      </Card>

      <Card style={styles.devCard}>
        <Text style={type.label}>DEVELOPER</Text>
        <Text style={type.heading}>Capture spike (D004)</Text>
        <Text style={styles.copy}>
          Runs the AR session for two minutes and scores frame rate, thermal
          state, anchoring and Hermes.
        </Text>
        <View style={styles.action}>
          <Button
            label="Open spike harness"
            variant="secondary"
            onPress={onOpenSpike}
          />
        </View>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  copy: { ...type.body, color: colors.muted },
  action: { marginTop: space.sm },
  devCard: { backgroundColor: colors.background },
});
