import React, { useState } from 'react';
import {
  requireNativeComponent,
  StyleSheet,
  useWindowDimensions,
  type NativeSyntheticEvent,
  type ViewProps,
} from 'react-native';

type NativeProps = ViewProps & {
  buttonTitle: string;
  spokenLabel: string;
  hint?: string;
  primary: boolean;
  compact: boolean;
  disabled: boolean;
  onPress: () => void;
  onSizeChange: (event: NativeSyntheticEvent<{ height: number }>) => void;
};
const NativeButton = requireNativeComponent<NativeProps>('STMActionButton');

export function NativeActionButton({
  label,
  onPress,
  primary = false,
  compact = false,
  disabled = false,
  accessibilityLabel = label,
  accessibilityHint,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  compact?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}) {
  const { fontScale } = useWindowDimensions();
  const minimumHeight = compact ? 48 : 56;
  const [height, setHeight] = useState(minimumHeight);
  return (
    <NativeButton
      buttonTitle={label}
      spokenLabel={accessibilityLabel}
      hint={accessibilityHint}
      primary={primary}
      compact={compact}
      disabled={disabled}
      // UIKit exposes the actual UIButton to accessibility, not this wrapper.
      accessible={false}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      onPress={() => {
        if (!disabled) {
          onPress();
        }
      }}
      onSizeChange={({ nativeEvent }) => {
        if (Number.isFinite(nativeEvent.height) && nativeEvent.height > 0) {
          setHeight(Math.max(minimumHeight, Math.ceil(nativeEvent.height)));
        }
      }}
      style={[
        { height },
        compact && styles.compact,
        compact ? { width: 96 * fontScale } : undefined,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  compact: { maxWidth: '70%', flexShrink: 1 },
});
