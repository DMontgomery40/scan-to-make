import React from 'react';
import {
  Platform,
  requireNativeComponent,
  Text,
  type NativeSyntheticEvent,
  type ViewProps,
} from 'react-native';
import type { ArtifactRef } from '@scan-to-make/contracts';
export interface MeshReady {
  sha256: string;
  triangleCount: number;
  widthMm: number;
  depthMm: number;
  heightMm: number;
}
interface Props extends ViewProps {
  artifact: ArtifactRef;
  onReady: (event: NativeSyntheticEvent<MeshReady>) => void;
  onFailure: (event: NativeSyntheticEvent<{ message: string }>) => void;
}
const Mesh =
  Platform.OS === 'ios'
    ? requireNativeComponent<Props>('ArtifactMeshView')
    : null;
export function ArtifactMesh(props: Props) {
  return Mesh ? (
    <Mesh {...props} />
  ) : (
    <Text>Mesh preview is available in the iOS app.</Text>
  );
}
