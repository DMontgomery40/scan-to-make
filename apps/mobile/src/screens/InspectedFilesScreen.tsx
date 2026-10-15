import React, { useEffect, useRef, useState } from 'react';
import { AppState, Text } from 'react-native';
import type { SavedProjects } from '@scan-to-make/contracts/saved-project';
import { CaptureClient, captureNative } from '../capture/retainedCaptures';
import {
  PreparedFilesClient,
  preparedNative,
  preparedError,
  type PreparedSummary,
  type PreparedJob,
  type ProjectAcknowledgment,
} from '../prepared/preparedFiles';
import { Button, Card, Screen } from '../ui/components';
import { type } from '../ui/theme';

export function InspectedFilesScreen({
  id,
  repository,
  onBack,
  onCompanion,
  paused = false,
}: {
  id: string;
  repository: SavedProjects;
  onBack: () => void;
  onCompanion: () => void;
  paused?: boolean;
}) {
  const [clients] = useState(() => {
    try {
      return {
        sync: new CaptureClient(repository, captureNative()),
        files: new PreparedFilesClient(repository, preparedNative()),
      };
    } catch {
      return null;
    }
  });
  const epoch = useRef(0),
    running = useRef(false);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('Loading inspected files…');
  const [items, setItems] = useState<PreparedSummary[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  const [ack, setAck] = useState<ProjectAcknowledgment | null>(null);
  const [selected, setSelected] = useState<{
    summary: PreparedSummary;
    job: PreparedJob;
  } | null>(null);
  const [unreadable, setUnreadable] = useState(0);
  function clear() {
    setItems([]);
    setCursor(null);
    setAck(null);
    setSelected(null);
    setUnreadable(0);
  }
  function invalidate() {
    epoch.current++;
    running.current = false;
    setBusy(false);
    clear();
    clients?.files.native.cancel().catch(() => {});
    clients?.sync.native.cancel().catch(() => {});
    setMessage('Refresh to check the current files.');
  }
  async function run(action: () => Promise<void>) {
    if (running.current || paused || !clients) return;
    running.current = true;
    setBusy(true);
    const token = epoch.current;
    try {
      await action();
    } catch (error) {
      if (token === epoch.current) {
        clear();
        setMessage(preparedError(error));
      }
    } finally {
      if (token === epoch.current) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  async function refresh() {
    if (!clients) return;
    await run(async () => {
      const token = epoch.current;
      clear();
      setMessage('Checking your saved project…');
      const state = await clients.sync.sync(id);
      if (token !== epoch.current) return;
      if (!state.etag || !state.snapshot)
        throw Error('The saved project could not be synchronized.');
      const next = { etag: state.etag, snapshot: state.snapshot };
      const page = await clients.files.list(id, next);
      if (token !== epoch.current) return;
      setAck(next);
      setItems(page.jobs);
      setCursor(page.nextCursor);
      setUnreadable(page.unreadable);
      setMessage(
        page.jobs.length
          ? 'Choose a file to review its inspection.'
          : page.nextCursor
          ? 'Continue to look for files.'
          : 'No inspected files for this saved version yet.',
      );
    });
  }
  useEffect(() => {
    refresh();
    const subscription = AppState.addEventListener('change', () =>
      invalidate(),
    );
    return () => {
      // This mutable counter invalidates all pending responses on unmount.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      epoch.current++;
      clients?.files.native.cancel().catch(() => {});
      clients?.sync.native.cancel().catch(() => {});
      subscription.remove();
    };
  }, [id, clients]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (paused) invalidate();
  }, [paused]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Screen
      title={selected ? 'File inspection' : 'Inspected files'}
      subtitle="Imported sliced files for this saved project."
      onBack={onBack}
    >
      <Text accessibilityLiveRegion="polite" style={type.body}>
        {clients ? message : 'Inspected files are available in the iOS app.'}
      </Text>
      {selected ? (
        <>
          <Card>
            <Text style={type.label}>IMPORTED SLICED FILE</Text>
            <Text style={type.heading}>
              {selected.job.printableArtifact.mediaType === 'model/3mf'
                ? '3MF'
                : 'G-code'}{' '}
              · Plate {selected.job.selection.plateIndex + 1}
            </Text>
            <Text style={type.body}>
              Model: {selected.job.inspection.receipt.inspection.model}
            </Text>
            <Text style={type.body}>
              Nozzle:{' '}
              {selected.job.inspection.receipt.inspection.nozzleDiameters.join(
                ' / ',
              )}{' '}
              mm
            </Text>
            <Text style={type.body}>
              Material:{' '}
              {Array.from(
                new Set(
                  selected.job.inspection.receipt.inspection.usedFilamentPositions.map(
                    p =>
                      selected.job.inspection.receipt.inspection.materials[p],
                  ),
                ),
              ).join(', ')}
            </Text>
            <Text style={type.body}>
              Bed: {selected.job.inspection.receipt.inspection.bedType}
            </Text>
            <Text style={type.caption}>
              This inspection describes the imported file. It does not confirm
              that it was sliced from your design or that it will fit.
            </Text>
            <Button
              label="Save file"
              disabled={busy || paused}
              onPress={() =>
                run(async () => {
                  if (!clients || !ack) return;
                  const token = epoch.current;
                  await clients.files.export(
                    id,
                    selected.summary.jobId,
                    ack,
                    selected.summary,
                  );
                  if (token === epoch.current)
                    setMessage('Saved to this app’s folder in Files.');
                })
              }
            />
          </Card>
          <Button
            label="Back to files"
            variant="secondary"
            disabled={busy}
            onPress={() => {
              setSelected(null);
              setMessage('Choose a file to review its inspection.');
            }}
          />
        </>
      ) : (
        <>
          <Button
            label={busy ? 'Checking files…' : 'Refresh files'}
            disabled={busy || paused || !clients}
            onPress={refresh}
          />
          {items.map((item, index) => (
            <Card key={item.jobId}>
              <Text style={type.heading}>
                File {index + 1} ·{' '}
                {item.printableArtifact.mediaType === 'model/3mf'
                  ? '3MF'
                  : 'G-code'}
              </Text>
              <Text style={type.caption}>
                {item.model} · Plate {item.plateIndex + 1} ·{' '}
                {item.printableArtifact.byteLength.toLocaleString()} bytes
              </Text>
              <Button
                label={`Review file ${index + 1}`}
                variant="secondary"
                disabled={busy || paused}
                onPress={() =>
                  run(async () => {
                    if (!clients || !ack) return;
                    const token = epoch.current;
                    const opened = await clients.files.open(
                      id,
                      item.jobId,
                      ack,
                      item,
                    );
                    if (token === epoch.current) {
                      setSelected({ summary: item, job: opened.job });
                      setMessage(
                        'File contents and inspection verified by your companion.',
                      );
                    }
                  })
                }
              />
            </Card>
          ))}
          {cursor && items.length < 1000 ? (
            <Button
              label="Load more files"
              variant="secondary"
              disabled={busy || paused}
              onPress={() =>
                run(async () => {
                  if (!clients || !ack) return;
                  const token = epoch.current;
                  const page = await clients.files.list(id, ack, cursor);
                  if (token !== epoch.current) return;
                  if (
                    items.length &&
                    page.jobs.length &&
                    items[items.length - 1].jobId >= page.jobs[0].jobId
                  )
                    throw Error('The file list changed. Refresh to try again.');
                  setItems([...items, ...page.jobs]);
                  setCursor(page.nextCursor);
                  setUnreadable(unreadable + page.unreadable);
                  setMessage(
                    page.jobs.length
                      ? 'More files loaded. Choose one to review.'
                      : page.nextCursor
                      ? 'Continue to look for files.'
                      : 'All available files loaded.',
                  );
                })
              }
            />
          ) : null}
          {cursor && items.length >= 1000 ? (
            <Text style={type.caption}>
              Showing the first 1,000 files. Refresh to check for changes.
            </Text>
          ) : null}
          {unreadable > 0 ? (
            <Text style={type.caption}>
              Some companion records could not be read. Only available files are
              shown.
            </Text>
          ) : null}
        </>
      )}
      <Button
        label="Connect companion"
        variant="secondary"
        onPress={() => {
          invalidate();
          onCompanion();
        }}
      />
    </Screen>
  );
}
