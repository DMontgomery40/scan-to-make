import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Button, Card, Screen } from '../ui/components';
import { type } from '../ui/theme';
export function AboutScreen({
  onBack,
  onOpenSpike,
}: {
  onBack: () => void;
  onOpenSpike: () => void;
}) {
  return (
    <Screen
      title="Built around real life."
      eyebrow="ABOUT SCAN TO MAKE"
      onBack={onBack}
    >
      <Text style={type.body}>
        Scan objects and their surroundings, describe an addition, and make
        something that fits. The goal is a useful part you can print, made for
        your space.
      </Text>
      <Card>
        <Text style={type.heading}>An open foundation</Text>
        <Text style={type.body}>
          Scan to Make is open source, with a self-hostable core. This early app
          lets you plan a project and explore a measured example.
        </Text>
      </Card>
      <View style={styles.tools}>
        <Text style={type.label}>DEVELOPER TOOLS</Text>
        <Text style={type.caption}>
          Inspect capture performance and runtime checks. These tools do not
          create a scan or verify physical fit.
        </Text>
        <Button
          label="Open spike harness"
          variant="secondary"
          onPress={onOpenSpike}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({ tools: { gap: 12 } });
