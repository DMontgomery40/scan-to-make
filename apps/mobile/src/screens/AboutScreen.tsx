import React from 'react';
import { Text } from 'react-native';
import { Button, Card, Screen } from '../ui/components';
import { type } from '../ui/theme';
export function AboutScreen({
  onCompanion,
  onBack,
}: {
  onCompanion?: () => void;
  onBack: () => void;
}) {
  return (
    <Screen
      title="Built around real objects."
      eyebrow="ABOUT SCAN TO MAKE"
      onBack={onBack}
    >
      <Text style={type.body}>
        Scan an object with your iPhone’s LiDAR, add close-up photos of the
        details, and let your computer clean up the scan’s defects. The result
        is a mesh you can measure and take to your printer tools.
      </Text>
      <Card>
        <Text style={type.heading}>An open foundation</Text>
        <Text style={type.body}>
          Scan to Make is open source. Cleanup runs on your own computer, so
          your scans stay with you.
        </Text>
      </Card>
      {onCompanion ? (
        <Button
          label="Your companion"
          variant="secondary"
          onPress={onCompanion}
        />
      ) : null}
    </Screen>
  );
}
