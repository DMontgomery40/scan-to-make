import React, { useEffect, useRef, useState } from 'react';
import { Alert, AppState, Text } from 'react-native';
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
import { Button, Card, Screen } from '../ui/components';
import { type } from '../ui/theme';

// Whether this device can scan. Scanning is only offered once the native
// status confirms it; it is never simulated on devices without LiDAR.
type ScanSupport =
  | 'checking'
  | 'supported'
  | 'no-lidar'
  | 'unsupported'
  | 'unknown';

export function RetainedCapturesScreen({
  id,
  repository,
  onBack,
  onCompanion,
  onResults,
}: {
  id: string;
  repository: SavedProjects;
  onBack: () => void;
  onCompanion: () => void;
  onResults?: (capture: RetainedCapture) => void;
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
  const [message, setMessage] = useState(
    'Scan an object or choose a saved USDZ scan to keep with this project.',
  );
  const [selected, setSelected] = useState<RetainedCapture | null>(null);
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
  async function run(
    action: () => Promise<unknown>,
    success: string | (() => string),
  ) {
    if (running.current || !client) return;
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
    await run(
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
              onPress={() =>
                run(async () => {
                  if (!scanner) return;
                  const draft = await scanner.start(id);
                  if (draft.addRequested)
                    setSelected(await scanner.add(id, draft));
                }, 'Your scan is kept on this device. Add a ready scan when you want to review it with this project.')
              }
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
                      onPress={() =>
                        send(
                          again => scanner.add(id, draft, undefined, again),
                          'Capture imported and verified. Open it to review the original scan.',
                        )
                      }
                    />
                    <Button
                      label={`Choose destination for scan ${index + 1}`}
                      variant="secondary"
                      disabled={busy || !!state.pending}
                      onPress={async () => {
                        if (running.current) return;
                        // Asked outside run(), so the answer is never dropped.
                        let destination;
                        try {
                          destination = await client.destination(id);
                        } catch (e) {
                          setMessage(
                            e instanceof Error
                              ? e.message
                              : 'The request could not be completed.',
                          );
                          return;
                        }
                        setMessage(
                          'Choose whether to add the scan to the current destination.',
                        );
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
                                  again =>
                                    scanner.add(id, draft, chosen, again),
                                  'Capture imported and verified.',
                                ),
                            },
                          ],
                        );
                      }}
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
            onPress={() => {
              // Chosen once; adding it again reuses the same file.
              let file: CaptureFile | undefined;
              send(async again => {
                file ??= await client.native.pick();
                const capture = await client.import(id, file, undefined, again);
                await client.reopen(id, capture);
                return capture;
              }, 'Capture imported and verified. Open it to review the original scan.');
            }}
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
    </Screen>
  );
}
