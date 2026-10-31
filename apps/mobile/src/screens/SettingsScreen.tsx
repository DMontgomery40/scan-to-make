import React from 'react';
import { Text } from 'react-native';
import { Button, Card, Screen } from '../ui/components';
import { type } from '../ui/theme';

/**
 * Settings (P9, first part): your Mac and what this app is. It replaces the
 * separate About screen.
 */
export function SettingsScreen({
  onPair,
  onBack,
}: {
  onPair: () => void;
  onBack: () => void;
}) {
  return (
    <Screen title="Settings" onBack={onBack}>
      <Card>
        <Text accessibilityRole="header" style={type.heading}>
          Your Mac
        </Text>
        <Text style={type.body}>
          Your Mac cleans up your scans and talks to your printer.
        </Text>
        <Button
          label="Pair or forget your Mac"
          variant="secondary"
          onPress={onPair}
        />
      </Card>
      <Card>
        <Text accessibilityRole="header" style={type.heading}>
          About Scan to Make
        </Text>
        <Text style={type.body}>
          Scan real objects with your iPhone’s LiDAR, then print them. Scan to
          Make is open source, and your projects stay on your phone and your
          Mac.
        </Text>
      </Card>
    </Screen>
  );
}
