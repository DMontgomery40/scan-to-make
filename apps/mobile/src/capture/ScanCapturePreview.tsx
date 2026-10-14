import React from 'react';
import { Platform, requireNativeComponent, type ViewProps } from 'react-native';
const NativePreview =
  Platform.OS === 'ios'
    ? requireNativeComponent<ViewProps>('ScanCapturePreview')
    : null;
/** Mounting this view never starts a session or requests camera access. */
export function ScanCapturePreview(props: ViewProps) {
  return NativePreview ? <NativePreview {...props} /> : null;
}
