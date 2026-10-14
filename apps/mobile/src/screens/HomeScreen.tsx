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
      subtitle="Make something that fits the things around you."
    >
      <Card>
        <Text style={type.label}>FIRST PROJECT</Text>
        <Text style={type.heading}>Cup holder adapter</Text>
        <Text style={styles.copy}>
          Scan your cup holder, confirm three measurements, and preview an
          adapter that fits your cup.
        </Text>
        <View style={styles.action}>
          <Button label="Start" onPress={onStartScan} />
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
