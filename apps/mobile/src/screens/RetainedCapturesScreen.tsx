import React, { useEffect, useState } from 'react';
import { Alert, Text } from 'react-native';
import type { SavedProjects } from '@scan-to-make/contracts/saved-project';
import {
  CaptureClient,
  captureNative,
  type CaptureState,
  type RetainedCapture,
} from '../capture/retainedCaptures';
import { Button, Card, Screen } from '../ui/components';
import { type } from '../ui/theme';

export function RetainedCapturesScreen({
  id,
  repository,
  onBack,
  onCompanion,
}: {
  id: string;
  repository: SavedProjects;
  onBack: () => void;
  onCompanion: () => void;
}) {
  const [client] = useState(() => {
    try {
      return new CaptureClient(repository, captureNative());
    } catch {
      return null;
    }
  });
  const [state, setState] = useState<CaptureState>({ captures: [] });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(
    'Choose a saved USDZ scan to keep with this project.',
  );
  const [selected, setSelected] = useState<RetainedCapture | null>(null);
  const refresh = async () => {
    if (client) setState(await client.state(id));
  };
  useEffect(() => {
    refresh().catch(e => setMessage(e.message));
    return () => {
      client?.native.cancel();
    };
  }, [id, client]); // eslint-disable-line react-hooks/exhaustive-deps
  async function run(action: () => Promise<unknown>, success: string) {
    if (busy || !client) return;
    setBusy(true);
    try {
      await action();
      setMessage(success);
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : 'The request could not be completed.',
      );
    } finally {
      await refresh().catch(() => {});
      setBusy(false);
    }
  }
  return (
    <Screen
      title="Project captures"
      subtitle="Keep the scan that informed your design."
      onBack={busy ? undefined : onBack}
    >
      <Text accessibilityLiveRegion="polite" style={type.body}>
        {message}
      </Text>
      <Text style={type.caption}>
        A capture is reference material. It does not accept a design or confirm
        that a printed part will fit.
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
            onPress={() =>
              run(async () => {
                const file = await client.native.pick();
                const capture = await client.import(id, file);
                await client.reopen(id, capture);
                setSelected(capture);
              }, 'Capture imported and verified. Open it to review the original scan.')
            }
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
