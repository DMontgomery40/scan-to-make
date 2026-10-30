import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  StyleSheet,
  Text,
  TextInput,
  Pressable,
  View,
} from 'react-native';
import {
  applyProjectFitSpecPatch,
  type DrawerFitSpec,
} from '@scan-to-make/contracts';
import type {
  SavedProject,
  SavedProjects,
} from '@scan-to-make/contracts/saved-project';
import {
  acceptArtifact,
  artifactError,
  artifactNative,
  generateAndAttach,
  shareArtifact,
  type GenerationToken,
} from '../design/artifacts';
import { ArtifactMesh, type MeshReady } from '../design/ArtifactMesh';
import {
  DRAWER_FIELDS,
  drawerExample,
  drawerPatch,
  drawerText,
} from '../fit/drawerDraft';
import { newProjectId } from '../project/savedProjects';
import { Button, Card, Screen } from '../ui/components';
import { colors, type } from '../ui/theme';

export function DrawerScreen({
  initial,
  repository,
  onProject,
  onCompanion,
  onBack,
  onPrintReview,
}: {
  onCompanion?: () => void;
  /** Opens print review for the accepted design. */
  onPrintReview?: (project: SavedProject) => void;
  initial: SavedProject | null;
  repository: SavedProjects;
  onProject: (project: SavedProject) => void;
  onBack: () => void;
}) {
  const [project, setProject] = useState(initial);
  const [seed] = useState(() => drawerExample(initial?.id ?? newProjectId()));
  const fit: DrawerFitSpec =
    project?.fit?.template === 'drawer-tray' ? project.fit : seed;
  const [text, setText] = useState(() => drawerText(fit));
  const [editing, setEditing] = useState(!initial?.preview);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [mesh, setMesh] = useState<MeshReady | null>(null);
  const [cacheEpoch, setCacheEpoch] = useState(0);
  const active = useRef<GenerationToken | null>(null);
  const mounted = useRef(true);
  const binding = project?.preview ?? null;
  const dirty = JSON.stringify(text) !== JSON.stringify(drawerText(fit));
  const update = (next: SavedProject) => {
    setProject(next);
    onProject(next);
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (active.current) {
        active.current.cancelled = true;
        try {
          artifactNative().cancel();
        } catch {}
      }
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setVerified(false);
    setMesh(null);
    if (binding) {
      try {
        artifactNative()
          .verifyCache(binding.artifact.sha256, binding.artifact.byteLength)
          .then(() => {
            if (!cancelled) {
              setVerified(true);
            }
          })
          .catch(error => {
            if (!cancelled) {
              setMessage(artifactError(error));
            }
          });
      } catch (error) {
        setMessage(artifactError(error));
      }
    }
    return () => {
      cancelled = true;
    };
  }, [binding, cacheEpoch]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') {
        setCacheEpoch(n => n + 1);
      }
    });
    return () => subscription.remove();
  }, []);
  const save = async () => {
    setBusy('Saving…');
    setMessage(null);
    try {
      const patch = drawerPatch(fit, text);
      const validated = applyProjectFitSpecPatch(fit, patch);
      const result = project?.fit
        ? await repository.change(project.id, project.revision, {
            kind: 'patch-fit',
            patch,
          })
        : project
        ? await repository.change(project.id, project.revision, {
            kind: 'attach-fit',
            fit: { ...validated, revision: 0 },
          })
        : await repository.create({
            id: fit.id,
            brief: {
              object: 'Drawer organizer study',
              context:
                'Synthetic drawer example; not a scan or physical measurement.',
              addition: 'A fitted tray with adjustable compartments.',
            },
            fit: { ...validated, revision: 0 },
          });
      if (result.status !== 'ok') {
        throw new Error(
          result.status === 'stale'
            ? 'The saved project changed. Your entries are kept; reopen the saved project before applying them.'
            : 'These sizes could not be saved. Your entries are still here.',
        );
      }
      update(result.project);
      setText(drawerText(result.project.fit as DrawerFitSpec));
      setEditing(false);
      setMessage('Saved on this device.');
    } catch (error) {
      setMessage(
        error instanceof Error && error.name === 'ZodError'
          ? 'These sizes or divider counts do not form a valid drawer tray. Check the height, clearance and compartment sizes.'
          : artifactError(error),
      );
    } finally {
      setBusy(null);
    }
  };
  const confirmSave = () => {
    if (
      project?.fit &&
      Object.values(fit.interfaces).some(
        value => value.fitEvidence.length > 0,
      ) &&
      dirty
    ) {
      Alert.alert(
        'Change the drawer fit?',
        'Changing fit dimensions clears the previous fit observation and design acceptance.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Change and clear', style: 'destructive', onPress: save },
        ],
      );
    } else {
      save();
    }
  };
  const generate = async () => {
    if (!project?.fit) {
      return;
    }
    const token = { cancelled: false };
    active.current = token;
    setBusy('Generating your preview…');
    setMessage(null);
    try {
      const next = await generateAndAttach(
        project,
        repository,
        artifactNative(),
        token,
      );
      if (mounted.current && !token.cancelled) {
        update(next);
        setEditing(false);
        setCacheEpoch(n => n + 1);
        setMessage('Preview ready. Rotate it and review the compartments.');
      }
    } catch (error) {
      if (mounted.current) {
        setMessage(artifactError(error));
      }
    } finally {
      if (active.current === token) {
        active.current = null;
        if (mounted.current) {
          setBusy(null);
        }
      }
    }
  };
  const accept = async () => {
    if (!project || !binding || !mesh || !verified || dirty) {
      return;
    }
    setBusy('Saving acceptance…');
    setMessage(null);
    try {
      update(
        await acceptArtifact(project.id, binding, repository, artifactNative()),
      );
      setMessage('Design accepted for this saved revision.');
    } catch (error) {
      setVerified(false);
      setMesh(null);
      setMessage(artifactError(error));
    } finally {
      setBusy(null);
    }
  };
  const share = async () => {
    if (!project || !binding || !mesh || !verified || dirty) {
      return;
    }
    setBusy('Preparing exact STL…');
    setMessage(null);
    try {
      const result = await shareArtifact(
        project.id,
        binding,
        repository,
        artifactNative(),
      );
      setMessage(
        result.completed
          ? 'STL shared. This does not authorize printing.'
          : 'Share sheet closed. Your accepted design is unchanged.',
      );
    } catch (error) {
      setVerified(false);
      setMesh(null);
      setMessage(artifactError(error));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Screen
      title={editing ? 'Shape your drawer tray.' : 'A place for everything.'}
      eyebrow="DRAWER ORGANIZER / DESIGN STUDY"
      subtitle="Explore a fitting tray, then review the actual generated shape."
      onBack={() => {
        if (!busy) {
          onBack();
        }
      }}
      footer={
        <>
          {onCompanion ? (
            <Button
              label="Companion connection"
              variant="secondary"
              disabled={!!busy}
              onPress={onCompanion}
            />
          ) : null}
          {message ? (
            <Text accessibilityLiveRegion="polite" style={styles.message}>
              {message}
            </Text>
          ) : null}
          {busy ? (
            <Text accessibilityLiveRegion="polite" style={type.caption}>
              {busy}
            </Text>
          ) : null}
          {busy?.startsWith('Generating') ? (
            <Button
              label="Cancel generation"
              variant="secondary"
              onPress={() => {
                if (active.current) {
                  active.current.cancelled = true;
                }
                artifactNative().cancel();
              }}
            />
          ) : editing ? (
            <Button
              label="Save drawer sizes"
              disabled={!!busy}
              onPress={confirmSave}
            />
          ) : (
            <>
              {project?.acceptedArtifact && verified && mesh && !dirty ? (
                <>
                  {onPrintReview ? (
                    <Button
                      label="Review print"
                      disabled={!!busy}
                      onPress={() => onPrintReview(project)}
                    />
                  ) : null}
                  <Button
                    label="Export STL"
                    variant={onPrintReview ? 'secondary' : 'primary'}
                    disabled={!!busy}
                    onPress={share}
                  />
                </>
              ) : binding && verified && mesh && !dirty ? (
                <Button
                  label="Accept this design"
                  disabled={!!busy}
                  onPress={accept}
                />
              ) : (
                <Button
                  label="Generate preview"
                  disabled={!!busy || dirty || !project?.fit}
                  onPress={generate}
                />
              )}
              <Button
                label="Edit drawer sizes"
                variant="secondary"
                disabled={!!busy}
                onPress={() => {
                  setEditing(true);
                  setMessage(null);
                }}
              />
            </>
          )}
        </>
      }
    >
      <Card style={styles.notice}>
        <Text style={type.label}>SYNTHETIC EXAMPLE · NOT MEASURED</Text>
        <Text style={type.caption}>
          These reference sizes explore a drawer organizer. They are not a scan
          or a verified fit. Square inside corners are assumed.
        </Text>
      </Card>
      {editing ? (
        <>
          <Text style={type.heading}>The space and the part</Text>
          {DRAWER_FIELDS.map(([key, label]) => (
            <View key={key} style={styles.row}>
              <View style={styles.fieldLabel}>
                <Text style={type.body}>{label}</Text>
                <Text style={type.caption}>
                  {fit.dimensions[key].source === 'reference'
                    ? 'Reference size · synthetic'
                    : 'Design choice'}{' '}
                  · mm
                </Text>
              </View>
              <TextInput
                accessibilityLabel={`${label}, millimetres`}
                value={text[key]}
                onChangeText={value => setText(t => ({ ...t, [key]: value }))}
                keyboardType="decimal-pad"
                editable={!busy}
                style={styles.input}
              />
            </View>
          ))}
          <Text style={type.heading}>Compartments</Text>
          {(['dividersAcross', 'dividersAlong'] as const).map(key => (
            <View key={key} style={styles.row}>
              <Text style={styles.fieldLabel}>
                {key === 'dividersAcross'
                  ? 'Dividers across'
                  : 'Dividers along'}
              </Text>
              <View style={styles.stepper}>
                {[-1, 1].map(delta => (
                  <Pressable
                    key={delta}
                    accessibilityRole="button"
                    accessibilityLabel={`${
                      delta > 0 ? 'Add' : 'Remove'
                    } divider ${key === 'dividersAcross' ? 'across' : 'along'}`}
                    disabled={
                      !!busy ||
                      Number(text[key]) + delta < 0 ||
                      Number(text[key]) + delta > 8
                    }
                    onPress={() =>
                      setText(t => ({
                        ...t,
                        [key]: String(Number(t[key]) + delta),
                      }))
                    }
                    style={styles.stepButton}
                  >
                    <Text style={type.heading}>{delta > 0 ? '+' : '−'}</Text>
                  </Pressable>
                ))}
                <Text style={type.heading}>{text[key]}</Text>
              </View>
            </View>
          ))}
          <Text style={type.caption}>
            Saving an effective fit change clears the previous preview and
            acceptance. Your idea stays with the project.
          </Text>
        </>
      ) : (
        <>
          {binding && verified ? (
            <>
              <ArtifactMesh
                key={`${binding.artifact.sha256}-${cacheEpoch}`}
                artifact={binding.artifact}
                style={styles.mesh}
                onReady={event => {
                  if (event.nativeEvent.sha256 === binding.artifact.sha256) {
                    setMesh(event.nativeEvent);
                  }
                }}
                onFailure={event => {
                  setVerified(false);
                  setMesh(null);
                  setMessage(event.nativeEvent.message);
                }}
              />
              <Text style={type.caption}>Drag to rotate · pinch to zoom</Text>
              {mesh ? (
                <Text style={type.body}>
                  {mesh.widthMm.toFixed(1)} × {mesh.depthMm.toFixed(1)} ×{' '}
                  {mesh.heightMm.toFixed(1)} mm · {mesh.triangleCount} triangles
                </Text>
              ) : (
                <Text style={type.caption}>Loading the verified mesh…</Text>
              )}
            </>
          ) : (
            <Card style={styles.empty}>
              <Text style={type.heading}>
                {binding
                  ? 'Preview file unavailable'
                  : 'Ready to make a design.'}
              </Text>
              <Text style={type.body}>
                {binding
                  ? 'A saved receipt alone is not enough to review or export a design. The exact file must be available and verified.'
                  : 'Generate a tray from your saved sizes. You’ll see the returned mesh before accepting anything.'}
              </Text>
            </Card>
          )}
          <Card style={styles.summary}>
            <Text style={type.label}>
              {project?.acceptedArtifact && verified
                ? 'DESIGN ACCEPTED'
                : 'DESIGN REVIEW'}
            </Text>
            <Text style={type.body}>
              Fit revision {fit.revision} · saved revision{' '}
              {project?.revision ?? 0}
            </Text>
            <Text style={type.caption}>
              {fit.parameters.dividersAcross + 1} ×{' '}
              {fit.parameters.dividersAlong + 1} compartments. Design acceptance
              does not verify physical fit or authorize printing.
            </Text>
            {binding ? (
              <>
                <Text selectable style={styles.digest}>
                  STL · {binding.artifact.byteLength.toLocaleString()} bytes
                  {'\n'}SHA-256 {binding.artifact.sha256}
                </Text>
                <Button
                  label="Regenerate preview"
                  variant="secondary"
                  disabled={!!busy || dirty}
                  onPress={generate}
                />
              </>
            ) : null}
          </Card>
          <Text style={type.caption}>
            Your connected companion creates the design. Manage its connection
            below if it needs attention.
          </Text>
        </>
      )}
    </Screen>
  );
}
const styles = StyleSheet.create({
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  stepButton: {
    minWidth: 48,
    minHeight: 48,
    borderRadius: 14,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  notice: { gap: 8, backgroundColor: colors.sand },
  row: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  fieldLabel: { ...type.body, flex: 1 },
  input: {
    width: 96,
    minHeight: 52,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 14,
    padding: 12,
    color: colors.ink,
    backgroundColor: colors.surface,
    fontSize: 17,
    textAlign: 'right',
  },
  mesh: { height: 310, borderRadius: 22, overflow: 'hidden' },
  empty: { padding: 24, gap: 14 },
  summary: { gap: 12 },
  digest: { ...type.caption, fontSize: 11 },
  message: { ...type.caption, color: colors.ink },
});
