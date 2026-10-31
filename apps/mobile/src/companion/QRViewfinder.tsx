import React from 'react';
import {
  Platform,
  requireNativeComponent,
  StyleSheet,
  View,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

export type ViewfinderState = 'ready' | 'no-camera' | 'denied';

type NativeProps = {
  active: boolean;
  onCode: (event: NativeSyntheticEvent<{ value: string }>) => void;
  onState: (event: NativeSyntheticEvent<{ state: ViewfinderState }>) => void;
  style?: StyleProp<ViewStyle>;
};

// The native view ships in the iOS app (QRScannerView.mm).
const NativeViewfinder =
  Platform.OS === 'ios'
    ? requireNativeComponent<NativeProps>('STMQRScannerView')
    : null;

/**
 * The live camera that reads your Mac's code, built into the screen. It
 * reports one code and then waits: turn `active` off and on to read again.
 */
export function QRViewfinder({
  active,
  onCode,
  onState,
  style,
}: {
  active: boolean;
  onCode: (value: string) => void;
  onState: (state: ViewfinderState) => void;
  style?: StyleProp<ViewStyle>;
}) {
  if (!NativeViewfinder) {
    return <View style={[styles.fill, style]} />;
  }
  return (
    <NativeViewfinder
      active={active}
      onCode={event => onCode(event.nativeEvent.value)}
      onState={event => onState(event.nativeEvent.state)}
      style={[styles.fill, style]}
    />
  );
}

/** True where this build can show the viewfinder at all. */
export const hasViewfinder = () => NativeViewfinder !== null;

const styles = StyleSheet.create({ fill: { backgroundColor: '#000' } });
