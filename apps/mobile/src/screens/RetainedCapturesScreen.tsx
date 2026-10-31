import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { SavedProjects } from '@scan-to-make/contracts/saved-project';
import {
  CaptureClient,
  captureNative,
  retainedIndex,
  type CaptureFile,
  type CaptureState,
  type RetainedCapture,
} from '../capture/retainedCaptures';
import {
  NativeObjectCaptureClient,
  objectCaptureNative,
  type NativeCaptureDraft,
} from '../capture/nativeObjectCapture';
import { Button, Card, Field, READABLE_WIDTH, Screen } from '../ui/components';
import { colors, space, type } from '../ui/theme';

// Whether this device can scan. Scanning is only offered once the native
// status confirms it; it is never simulated on devices without LiDAR.
type ScanSupport =
  | 'checking'
  | 'supported'
  | 'no-lidar'
  | 'unsupported'
  | 'unknown';

const BUSY = 'Still working on the last request. Try again in a moment.';

export function RetainedCapturesScreen({
  id,
  repository,
  onBack,
  onCompanion,
  onResults,
  scanNow = false,
  onScanStarted,
}: {
  id: string;
  repository: SavedProjects;
  onBack: () => void;
  onCompanion: () => void;
  onResults?: (capture: RetainedCapture) => void;
  /** True to open the camera once, as Scan something does. */
  scanNow?: boolean;
  /** Called when that scan starts, so coming back doesn't start another. */
  onScanStarted?: () => void;
}) {
  const [client] = useState(() => {
    try {
      return new CaptureClient(repository, captureNative());
    } catch {
      return null;
    }
  });
  const [scanner] = useState(() => {
    const native = objectCaptureNative();
    return client && native
      ? new NativeObjectCaptureClient(client, native)
      : null;
  });
  const [support, setSupport] = useState<ScanSupport>(
    scanner ? 'checking' : 'unsupported',
  );
  const [activeRunID, setActiveRunID] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<NativeCaptureDraft[]>([]);
  const [state, setState] = useState<CaptureState>({ captures: [] });
  // The saved project's current version, which a new capture is bound to.
  const [revision, setRevision] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  // Set synchronously, so a second tap before the next render does nothing.
  const running = useRef(false);
  // Taps that look something up before they start a request (or open the
  // name sheet or a question) hold this from the tap until they hand off.
  const starting = useRef(false);
  const once = (task: () => Promise<unknown>) => async () => {
    if (starting.current || running.current) return;
    starting.current = true;
    try {
      await task();
    } finally {
      starting.current = false;
    }
  };
  const [message, setMessage] = useState(
    'Scan an object or choose a saved USDZ scan to keep with this project.',
  );
  const [selected, setSelected] = useState<RetainedCapture | null>(null);
  // A finished scan whose project still needs its name (P2: name after), and
  // whether to add it to the project once named.
  // A USDZ file chosen for an unnamed project waits for the name too.
  const [finished, setFinished] = useState<{
    draft: NativeCaptureDraft | null;
    add: boolean;
    then?: () => void;
  } | null>(null);
  const refresh = async () => {
    // Local scans remain available even when there is no companion connection.
    if (scanner) {
      const status = await scanner.native.status().catch(() => null);
      setSupport(
        !status
          ? 'unknown'
          : status.supported
          ? 'supported'
          : status.lidar === false
          ? 'no-lidar'
          : 'unsupported',
      );
      if (status) setActiveRunID(status.activeRunID);
      setDrafts(await scanner.drafts(id));
    }
    // The version and the captures held for it are shown together.
    const project = await repository.load(id);
    const next = client ? await client.state(id) : null;
    setRevision(project.status === 'ok' ? project.project.revision : null);
    if (next) setState(next);
  };
  useEffect(() => {
    refresh().catch(e => setMessage(e.message));
    const subscription = AppState.addEventListener('change', value => {
      if (value === 'active') refresh().catch(e => setMessage(e.message));
    });
    return () => {
      subscription.remove();
      client?.native.cancel().catch(() => {});
      scanner?.native.stop().catch(() => {});
    };
  }, [id, client, scanner]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!scanner || !activeRunID) return;
    let cancelled = false;
    const timer = setInterval(() => {
      scanner.native
        .status()
        .then(status => {
          if (!cancelled && !status.activeRunID) {
            setActiveRunID(null);
            refresh().catch(e => {
              if (!cancelled) setMessage(e.message);
            });
          }
        })
        .catch(() => {});
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [scanner, activeRunID]); // eslint-disable-line react-hooks/exhaustive-deps
  const scan = async () => {
    const toName: { draft?: NativeCaptureDraft } = {};
    await run(async () => {
      if (!scanner) return;
      const draft = await scanner.start(id);
      if (draft.status === 'ready' && (await unnamed())) {
        toName.draft = draft;
        return;
      }
      if (draft.addRequested) setSelected(await scanner.add(id, draft));
    }, 'Your scan is kept on this device. Add a ready scan when you want to review it with this project.');
    // Named first, so the scan joins the project under its name. Asked once
    // this run has let go, so Continue can start the next one.
    const { draft } = toName;
    if (draft) setFinished({ draft, add: !!draft.addRequested });
  };
  const unnamed = async () => {
    const project = await repository.load(id);
    return project.status === 'ok' && project.project.brief.object === '';
  };
  // Scan something: the camera opens first, once.
  useEffect(() => {
    // Waits out a running check, so only a real start uses the request.
    if (!scanNow || support !== 'supported' || activeRunID || busy) return;
    onScanStarted?.();
    scan();
  }, [scanNow, support, activeRunID, busy]); // eslint-disable-line react-hooks/exhaustive-deps
  // Saves the name, then adds the scan to the named project. Returns why the
  // sheet should stay open, or null once it's done.
  const name = async (value: string): Promise<string | null> => {
    const draft = finished?.draft;
    const add = finished?.add;
    const then = finished?.then;
    const project = await repository.load(id).catch(() => null);
    const saved =
      project?.status === 'ok'
        ? await repository
            .change(id, project.project.revision, {
              kind: 'replace-brief',
              brief: { ...project.project.brief, object: value },
            })
            .catch(() => null)
        : null;
    if (saved?.status !== 'ok')
      return 'The name couldn’t be saved. Your scan is kept on this phone.';
    if (
      draft &&
      add &&
      scanner &&
      !(await send(
        again => scanner.add(id, draft, undefined, again),
        'Capture imported and verified. Open it to review the original scan.',
      ))
    )
      return BUSY;
    setFinished(null);
    if (then) then();
    else if (!(draft && add)) await refresh().catch(() => {});
    return null;
  };
  // Use the current destination, after asking (asked outside run(), so the
  // answer is never dropped).
  const choose = async (draft: NativeCaptureDraft) => {
    if (!client || !scanner) return;
    let destination;
    try {
      destination = await client.destination(id);
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : 'The request could not be completed.',
      );
      return;
    }
    setMessage('Choose whether to add the scan to the current destination.');
    const chosen = destination;
    Alert.alert(
      'Use the current project version?',
      `Add this retained scan to project version ${chosen.revision} on your connected companion? Its original files stay on this device.`,
      [
        { text: 'Keep for later', style: 'cancel' },
        {
          text: 'Add to this version',
          onPress: () =>
            send(
              again => scanner.add(id, draft, chosen, again),
              'Capture imported and verified.',
            ),
        },
      ],
    );
  };
  // One request at a time. One that can't start says so, and reports false,
  // so nothing is ever dropped silently.
  async function run(
    action: () => Promise<unknown>,
    success: string | (() => string),
  ): Promise<boolean> {
    if (!client) return false;
    if (running.current) {
      setMessage(BUSY);
      return false;
    }
    running.current = true;
    setBusy(true);
    try {
      await action();
      setMessage(typeof success === 'string' ? success : success());
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : 'The request could not be completed.',
      );
    } finally {
      await refresh().catch(() => {});
      running.current = false;
      setBusy(false);
    }
    return true;
  }
  // Imports, and if an earlier unconfirmed upload may have sent the same
  // bytes, asks before sending them again (after this run has finished, so
  // the answer isn't dropped by the tap guard).
  async function send(
    upload: (again: boolean) => Promise<RetainedCapture>,
    success: string,
    again = false,
  ) {
    let ask: string | null = null;
    const ran = await run(
      async () => {
        try {
          setSelected(await upload(again));
        } catch (error) {
          // Not a failure: the alert below asks, and nothing was sent.
          if ((error as { code?: string })?.code !== 'maybe-imported')
            throw error;
          ask = (error as Error).message;
        }
      },
      () =>
        ask ? 'Nothing was sent. Choose whether to add it again.' : success,
    );
    if (ask)
      Alert.alert('Add this scan again?', ask, [
        { text: 'Keep for later', style: 'cancel' },
        {
          text: 'Add again',
          onPress: () => send(upload, success, true),
        },
      ]);
    return ran;
  }
  return (
    <Screen
      title="Project captures"
      subtitle="Scan the object with LiDAR. Each scan stays with this project."
      onBack={busy ? undefined : onBack}
    >
      <Text accessibilityLiveRegion="polite" style={type.body}>
        {message}
      </Text>
      <Text style={type.caption}>
        A scan is reference material. Check its size against the real object
        before you rely on it.
      </Text>
      <Button
        label="Connect companion"
        variant="secondary"
        disabled={busy}
        onPress={onCompanion}
      />
      {!client ? (
        <Text style={type.body}>
          Capture import is available in the iOS app.
        </Text>
      ) : (
        <>
          {support === 'supported' || support === 'checking' ? (
            <Button
              label="Scan object"
              disabled={busy || support !== 'supported' || !!activeRunID}
              onPress={() => scan()}
            />
          ) : support === 'unknown' ? (
            <Card>
              <Text style={type.heading}>Couldn’t check for LiDAR</Text>
              <Text accessibilityLiveRegion="polite" style={type.body}>
                Scanning stays off until this device confirms it has a LiDAR
                scanner.
              </Text>
              <Button
                label="Check again"
                variant="secondary"
                disabled={busy}
                onPress={() => run(refresh, 'Checked this device again.')}
              />
            </Card>
          ) : (
            <Card>
              <Text style={type.heading}>
                {support === 'no-lidar'
                  ? 'Scanning needs LiDAR'
                  : 'Scanning isn’t available here'}
              </Text>
              <Text accessibilityLiveRegion="polite" style={type.body}>
                {support === 'no-lidar'
                  ? 'This device has no LiDAR scanner, so it can’t make a true-to-size scan. Scan the object on an iPhone or iPad with LiDAR. You can still add a USDZ scan file to this project here.'
                  : 'This device doesn’t support Object Capture, so it can’t make a scan. Scan the object on an iPhone or iPad with LiDAR. You can still add a USDZ scan file to this project here.'}
              </Text>
            </Card>
          )}
          {activeRunID ? (
            <Text accessibilityLiveRegion="polite" style={type.body}>
              A scan is still active or stopping. Your files are kept. A new
              scan becomes available after it finishes.
            </Text>
          ) : null}
          {scanner ? (
            <Button
              label="Refresh local scans"
              variant="secondary"
              disabled={busy}
              onPress={() => run(refresh, 'Local scans refreshed.')}
            />
          ) : null}
          {drafts.map((draft, index) => {
            // Adding the same scan again would make a second copy on the companion.
            const added =
              draft.file && revision !== null
                ? retainedIndex(state, revision, draft.file)
                : -1;
            return (
              <Card key={draft.runID}>
                <Text style={type.heading}>Local scan {index + 1}</Text>
                <Text style={type.body}>
                  {added >= 0
                    ? `Added to this project as capture ${added + 1}`
                    : draft.status === 'ready'
                    ? 'Ready to add'
                    : draft.status === 'stopping'
                    ? 'Stopping scan'
                    : draft.status === 'capturing'
                    ? 'Scan in progress'
                    : 'Original files kept on this device'}
                </Text>
                {draft.message ? (
                  <Text style={type.body}>{draft.message}</Text>
                ) : null}
                {draft.file ? (
                  <Text style={type.caption}>
                    {(draft.file.byteLength / 1048576).toFixed(1)} MB · Project
                    version {draft.origin.revision}
                  </Text>
                ) : null}
                {draft.status === 'ready' && added < 0 && scanner ? (
                  <>
                    <Button
                      label={`Add scan ${index + 1} to this project`}
                      disabled={busy || !!state.pending}
                      onPress={once(async () => {
                        // A scan kept from before the project had a name
                        // (the app closed first) is named before it's added.
                        if (await unnamed()) setFinished({ draft, add: true });
                        else
                          await send(
                            again => scanner.add(id, draft, undefined, again),
                            'Capture imported and verified. Open it to review the original scan.',
                          );
                      })}
                    />
                    <Button
                      label={`Choose destination for scan ${index + 1}`}
                      variant="secondary"
                      disabled={busy || !!state.pending}
                      onPress={once(async () => {
                        // An unnamed project is named first; the choice
                        // below then follows, for the named version.
                        if (await unnamed()) {
                          setFinished({
                            draft,
                            add: false,
                            then: () => choose(draft),
                          });
                          return;
                        }
                        await choose(draft);
                      })}
                    />
                  </>
                ) : null}
              </Card>
            );
          })}
          <Button
            label={busy ? 'Working…' : 'Sync saved project'}
            disabled={busy}
            onPress={() =>
              run(
                () => client.sync(id),
                'The saved version is synchronized. Any newer local edits are still on this device.',
              )
            }
          />
          <Button
            label="Choose USDZ capture"
            disabled={busy || !!state.pending}
            onPress={once(async () => {
              // Chosen once; adding it again reuses the same file.
              let file: CaptureFile | undefined;
              const pick = () =>
                send(async again => {
                  file ??= await client.native.pick();
                  const capture = await client.import(
                    id,
                    file,
                    undefined,
                    again,
                  );
                  await client.reopen(id, capture);
                  return capture;
                }, 'Capture imported and verified. Open it to review the original scan.');
              // An unnamed project gets its name before anything joins it.
              if (await unnamed())
                setFinished({ draft: null, add: false, then: pick });
              else await pick();
            })}
          />
          {state.pending ? (
            <Card>
              <Text style={type.heading}>Import unconfirmed</Text>
              <Text style={type.body}>
                The companion may have saved this capture before the connection
                ended. Starting again could create a second copy.
              </Text>
              <Button
                label="Review unconfirmed import"
                variant="secondary"
                disabled={busy}
                onPress={() =>
                  Alert.alert(
                    'Start a separate import?',
                    'The previous capture may still be on the companion. This keeps those bytes and allows you to explicitly choose another file.',
                    [
                      { text: 'Keep waiting', style: 'cancel' },
                      {
                        text: 'Allow a new import',
                        onPress: () =>
                          run(
                            () => client.acknowledgeUnknown(id),
                            'You can choose a file for a separate import.',
                          ),
                      },
                    ],
                  )
                }
              />
            </Card>
          ) : null}
          {state.captures.map((capture, index) => (
            <Card key={capture.captureId}>
              <Text style={type.heading}>Capture {index + 1}</Text>
              <Text style={type.caption}>
                Project version {capture.binding.projectRevision} ·{' '}
                {(
                  capture.binding.capture.original.byteLength / 1048576
                ).toFixed(1)}{' '}
                MB
              </Text>
              {onResults ? (
                <Button
                  label="See scan results"
                  accessibilityLabel={`See scan results for capture ${
                    index + 1
                  }`}
                  disabled={busy}
                  onPress={() => onResults(capture)}
                />
              ) : null}
              <Button
                label={`Reopen capture ${index + 1}`}
                variant="secondary"
                disabled={busy}
                onPress={() =>
                  run(async () => {
                    await client.reopen(id, capture);
                    setSelected(capture);
                  }, 'The retained capture and its files were verified by your companion.')
                }
              />
            </Card>
          ))}
          {selected ? (
            <Card>
              <Text style={type.heading}>Review capture</Text>
              <Text style={type.body}>
                Original scan and converted mesh are retained. Measurements and
                surface completeness still need checking.
              </Text>
              <Text style={type.caption}>
                Coordinates: {selected.binding.capture.provenance.upAxis} up ·{' '}
                {selected.binding.capture.provenance.metersPerUnit} meters per
                unit
              </Text>
              <Button
                label="Review converted mesh"
                disabled={busy}
                onPress={() =>
                  run(
                    () => client.openFile(id, selected, 'derived', false),
                    'Converted mesh verified.',
                  )
                }
              />
              <Button
                label="View original scan"
                disabled={busy}
                onPress={() =>
                  run(
                    () => client.openFile(id, selected, 'original', false),
                    'Original scan verified.',
                  )
                }
              />
              <Button
                label="Export original USDZ"
                variant="secondary"
                disabled={busy}
                onPress={() =>
                  run(
                    () => client.openFile(id, selected, 'original', true),
                    'Share sheet closed. The original bytes were verified.',
                  )
                }
              />
              <Button
                label="Export converted OBJ"
                variant="secondary"
                disabled={busy}
                onPress={() =>
                  run(
                    () => client.openFile(id, selected, 'derived', true),
                    'Share sheet closed. The converted bytes were verified.',
                  )
                }
              />
              <Button
                label="Export conversion report"
                variant="secondary"
                disabled={busy}
                onPress={() =>
                  run(
                    () => client.openFile(id, selected, 'report', true),
                    'Share sheet closed. The report bytes were verified.',
                  )
                }
              />
            </Card>
          ) : null}
        </>
      )}
      <FinishedSheet
        visible={finished !== null}
        busy={busy}
        title={finished?.draft === null ? 'Name this project' : 'Scan finished'}
        onName={name}
        onLater={() => setFinished(null)}
      />
    </Screen>
  );
}

/**
 * Scan finished (P2, mockup 02): the project gets its name now, after the
 * scan. The scan stays on this phone until the name is saved.
 */
function FinishedSheet({
  visible,
  busy,
  title,
  onName,
  onLater,
}: {
  visible: boolean;
  /** Another request is still running: Continue waits for it. */
  busy: boolean;
  title: string;
  onName: (name: string) => Promise<string | null>;
  /** Closes the sheet; the scan stays on this phone to add later. */
  onLater: () => void;
}) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  // Held synchronously, so a double tap names and adds once.
  const savingNow = useRef(false);
  const [failed, setFailed] = useState<string | null>(null);
  const trimmed = name.trim();
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={saving ? undefined : onLater}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.sheet}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.sheetScroll}
        >
          <View style={styles.sheetColumn}>
            <Text accessibilityRole="header" style={styles.finished}>
              {title}
            </Text>
            <Field
              label="What did you scan?"
              hint="Name it so you can find it later."
              value={name}
              onChangeText={setName}
              editable={!saving}
              maxLength={200}
              returnKeyType="done"
            />
            {failed ? (
              <Text accessibilityLiveRegion="polite" style={type.body}>
                {failed}
              </Text>
            ) : null}
            <Button
              label={saving ? 'Saving…' : 'Continue'}
              disabled={saving || busy || !trimmed}
              onPress={async () => {
                if (savingNow.current) return;
                savingNow.current = true;
                setSaving(true);
                setFailed(null);
                try {
                  const problem = await onName(trimmed);
                  if (problem === null) setName('');
                  else setFailed(problem);
                } finally {
                  savingNow.current = false;
                  setSaving(false);
                }
              }}
            />
            <Button
              label="Not now"
              variant="secondary"
              disabled={saving}
              onPress={onLater}
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: colors.background },
  sheetScroll: { padding: space.xl, alignItems: 'center' },
  sheetColumn: { width: '100%', maxWidth: READABLE_WIDTH, gap: space.lg },
  finished: { ...type.heading, color: colors.pass },
});
