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
  systemImage?: string;
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
  systemImage,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  compact?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  /** SF Symbol name. With an empty label the button is a round icon button. */
  systemImage?: string;
}) {
  const { fontScale } = useWindowDimensions();
  const iconOnly = !label && !!systemImage;
  const minimumHeight = iconOnly ? 44 : compact ? 48 : 56;
  const [height, setHeight] = useState(minimumHeight);
  return (
    <NativeButton
      buttonTitle={label}
      spokenLabel={accessibilityLabel}
      hint={accessibilityHint}
      primary={primary}
      compact={compact}
      disabled={disabled}
      systemImage={systemImage}
      // Only the UIButton inside is an accessibility element: it carries the
      // label, hint, button trait and disabled state. Accessibility props on
      // this wrapper made VoiceOver find the same button three times (KAN-187).
      accessible={false}
      onPress={() => {
        if (!disabled) {
          onPress();
        }
      }}
      onSizeChange={({ nativeEvent }) => {
        if (iconOnly) return;
        if (Number.isFinite(nativeEvent.height) && nativeEvent.height > 0) {
          setHeight(Math.max(minimumHeight, Math.ceil(nativeEvent.height)));
        }
      }}
      style={
        iconOnly
          ? { width: 44 * fontScale, height: 44 * fontScale }
          : [
              { height },
              compact && styles.compact,
              compact ? { width: 96 * fontScale } : undefined,
            ]
      }
    />
  );
}

const styles = StyleSheet.create({
  compact: { maxWidth: '70%', flexShrink: 1 },
});
