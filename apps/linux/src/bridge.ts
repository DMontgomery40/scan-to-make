import { invoke } from "@tauri-apps/api/core";
import type { HostStatus, ModelChoice, Project } from "./types";
export const call = <T>(method: string, params: object = {}): Promise<T> =>
  invoke("control", { method, params });
export const host = (action: "status" | "setup" | "start" | "stop") =>
  invoke<HostStatus>("host_action", { action });
export const storeCredential = (choice: ModelChoice, secret: string) =>
  invoke<{ choice: ModelChoice }>("store_credential", { choice, secret });
export const importFiles = (
  id: string,
  kind: "model" | "photos" | "scan",
  forMessage = false,
) =>
  invoke<{
    object?: Project;
    photoNames: string[];
    imported: number;
    errors: string[];
  }>("import_files", { id, kind, forMessage });
export const artifact = async (id: string, path: string) =>
  new Uint8Array(await invoke<ArrayBuffer>("read_artifact", { id, path }));
/** Bounded native read of the current review's preview STL; ids only, no path. */
export const reconstructionPreview = async (id: string, reviewId: string) =>
  new Uint8Array(
    await invoke<ArrayBuffer>("read_reconstruction_preview", { id, reviewId }),
  );
export const openLink = (url: string) => invoke<void>("open_link", { url });
/** Settings → About → Export Diagnostics… (#799): the native side asks where to save, reads the companion's
 * diagnostics.bundle and writes the ZIP; the window never sees the files. */
export const exportDiagnostics = () =>
  invoke<{ saved: boolean; name?: string; companion?: boolean }>(
    "export_diagnostics",
  );
export const openProject = (
  id: string,
  application: "folder" | "blender" | "bambu-studio" | "orca",
) => invoke<void>("open_project", { id, application });
export const previewFile = async () => {
  const data = await invoke<ArrayBuffer>("preview_file");
  return new Uint8Array(data);
};
export interface PickedInput {
  token: string;
  name: string;
  kind: "model" | "photos" | "scan";
}
export const pickInputs = (kind: PickedInput["kind"]) =>
  invoke<PickedInput[]>("pick_inputs", { kind });
export const importSelected = (id: string, tokens: string[]) =>
  invoke<{ object?: Project; imported: number; errors: string[] }>(
    "import_selected",
    { id, tokens },
  );
export const releaseInputs = (tokens: string[]) =>
  invoke("release_inputs", { tokens });
