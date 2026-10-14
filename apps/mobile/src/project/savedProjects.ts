import { NativeModules } from 'react-native';
import {
  createSavedProjects,
  type SavedProjectStorage,
} from '@scan-to-make/contracts/saved-project';

// No memory fallback: a missing native module must never look like a saved draft.
export function localSavedProjects() {
  const native = NativeModules.LocalProjectStorage as
    | SavedProjectStorage
    | undefined;
  const requireNative = () => {
    if (!native) {
      throw new Error('Local storage is unavailable');
    }
    return native;
  };
  return createSavedProjects({
    listIds: () => requireNative().listIds(),
    read: id => requireNative().read(id),
    compareAndSwap: (id, expected, next) =>
      requireNative().compareAndSwap(id, expected, next),
  });
}
export function newProjectId() {
  return `project-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}-${Math.random().toString(36).slice(2)}`;
}
