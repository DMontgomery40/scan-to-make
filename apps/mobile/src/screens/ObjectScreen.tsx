import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Button, Field, Screen } from '../ui/components';
import { colors, radius, space, type } from '../ui/theme';
import { ObjectsError, type ObjectsClient } from '../objects/client';
import {
  describeObject,
  formatSize,
  type ObjectAction,
} from '../objects/model';
import type { ObjectCapture } from '../objects/capture';
import type { StmObject } from '../objects/types';

const POLL_MS = 3000;
const TONE = {
  pending: colors.pending,
  pass: colors.pass,
  fail: colors.fail,
  accent: colors.accent,
  neutral: colors.muted,
};

/** Keeps one object up to date: polls while it is busy and the app is in front. */
export function useObject(client: ObjectsClient, id: string, refreshKey = 0) {
  const [object, setObject] = useState<StmObject | null>(null);
  const [error, setError] = useState<ObjectsError | null>(null);
  const load = useCallback(async () => {
    try {
      setObject(await client.get(id));
      setError(null);
    } catch (e) {
      setError(e instanceof ObjectsError ? e : new ObjectsError('failed'));
    }
  }, [client, id]);
  useEffect(() => {
    load();
  }, [load, refreshKey]);
  const busy = object ? describeObject(object).busy : false;
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => {
      if (AppState.currentState !== 'background') load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [busy, load]);
  return { object, setObject, error, load };
}

function Renders({
  client,
  object,
}: {
  client: ObjectsClient;
  object: StmObject;
}) {
  const [uris, setUris] = useState<string[]>([]);
  // The space this page actually has (one pane of two on a wide screen).
  const [size, setSize] = useState(0);
  const renders = object.current?.renders ?? [];
  const key = `${object.id}:${object.updatedAtMs}:${renders.join()}`;
  useEffect(() => {
    let live = true;
    Promise.all(
      renders.map(render => client.renderUri(object, render).catch(() => null)),
    ).then(found => live && setUris(found.filter((u): u is string => !!u)));
    return () => {
      live = false;
    };
    // The key covers the object version and its renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return (
    <View
      testID="render-plate"
      onLayout={event =>
        setSize(Math.round(Math.min(event.nativeEvent.layout.width, 560)))
      }
      style={[styles.plate, size ? { height: size } : styles.plateUnmeasured]}
    >
      {uris.length && size ? (
        <ScrollView
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          accessibilityLabel={`Pictures of the model, ${uris.length}`}
        >
          {uris.map(uri => (
            <Image
              key={uri}
              source={{ uri }}
              resizeMode="contain"
              accessibilityIgnoresInvertColors
              testID="render-image"
              style={{ width: size, height: size }}
            />
          ))}
        </ScrollView>
      ) : (
        <Text style={styles.plateText}>
          {object.state === 'touching-up'
            ? 'The model shows here when it’s ready.'
            : 'No pictures yet.'}
        </Text>
      )}
    </View>
  );
}

function PlatePhoto({
  client,
  object,
}: {
  client: ObjectsClient;
  object: StmObject;
}) {
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (object.plate?.photo)
      client.plateUri(object).then(
        found => live && setUri(found),
        () => {},
      );
    return () => {
      live = false;
    };
    // A new photo comes with a new object version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [object.id, object.updatedAtMs, object.plate?.photo]);
  if (!uri) return null;
  return (
    <Image
      source={{ uri }}
      resizeMode="cover"
      accessibilityLabel="The printer camera’s view of the plate"
      style={styles.platePhoto}
    />
  );
}

export function ObjectScreen({
  client,
  capture,
  id,
  onBack,
  onPair,
  onChanged,
  refreshKey = 0,
}: {
  client: ObjectsClient;
  capture: ObjectCapture;
  id: string;
  /** Called after an action changes the object, so the list can follow. */
  onChanged?: () => void;
  /** Bumped by the app after pairing again, to load afresh. */
  refreshKey?: number;
  /** Absent in the two-pane layout, where the list stays on screen. */
  onBack?: () => void;
  onPair: () => void;
}) {
  const { object, setObject, error, load } = useObject(client, id, refreshKey);
  const [working, setWorking] = useState<ObjectAction | 'turn' | null>(null);
  const [problem, setProblem] = useState<ObjectsError | null>(null);
  const [note, setNote] = useState('');
  const [canScan, setCanScan] = useState(false);
  const resumed = useRef(false);
  const inFlight = useRef(false);
  useEffect(() => {
    capture.available().then(setCanScan, () => {});
  }, [capture]);

  const run = async (
    action: ObjectAction | 'turn',
    work: () => Promise<StmObject | null | void>,
  ) => {
    // A ref, not state: a double tap lands before the next render.
    if (inFlight.current) return;
    inFlight.current = true;
    setWorking(action);
    setProblem(null);
    try {
      const next = await work();
      if (next) setObject(next);
      else await load();
      onChanged?.();
    } catch (e) {
      setProblem(e instanceof ObjectsError ? e : new ObjectsError('failed'));
    } finally {
      inFlight.current = false;
      setWorking(null);
    }
  };

  // A scan that finished but wasn't sent (the app was closed) goes now.
  useEffect(() => {
    if (!object || resumed.current) return;
    // Any new object: the bridge sends only what the Mac doesn't have yet.
    if (object.state !== 'new') return;
    resumed.current = true;
    capture.finished(object.id).then(runID => {
      if (runID) run('scan', () => client.sendCapture(object.id, runID));
    });
    // Only once per object page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [object?.id, object?.state]);

  if (!object) {
    return (
      <Screen
        title={error ? 'Can’t reach your Mac' : 'Opening…'}
        onBack={onBack}
      >
        {error ? (
          <>
            <Text style={type.body}>{error.message}</Text>
            {error.kind === 'pairing' ? (
              <Button label="Connect to your Mac" onPress={onPair} />
            ) : (
              <Button label="Try again" variant="secondary" onPress={load} />
            )}
          </>
        ) : null}
      </Screen>
    );
  }

  const view = describeObject(object);
  const sendPhotos = async (pick: () => Promise<number>) => {
    const sent = await pick();
    if (!sent) return null;
    return object.state === 'needs-closeup'
      ? client.sendCloseups(object.id)
      : client.start(object.id);
  };
  const buttons: Record<ObjectAction, React.ReactNode> = {
    print: (
      <Button
        key="print"
        label={working === 'print' ? 'Sending to the printer…' : 'Print'}
        disabled={!!working}
        systemImage="printer"
        onPress={() => run('print', () => client.print(object.id))}
      />
    ),
    printChecked: (
      <Button
        key="printChecked"
        label="It isn’t printing, print again"
        disabled={!!working}
        onPress={() =>
          run('printChecked', () => client.print(object.id, { checked: true }))
        }
      />
    ),
    correct: null,
    openCamera: (
      <Button
        key="openCamera"
        label="Open camera"
        systemImage="camera"
        disabled={!!working}
        onPress={() =>
          run('openCamera', () => sendPhotos(() => client.takePhoto(object.id)))
        }
      />
    ),
    attachPhotos: (
      <Button
        key="attachPhotos"
        label="Attach photos"
        variant={object.state === 'needs-closeup' ? 'secondary' : 'primary'}
        systemImage="photo.on.rectangle"
        disabled={!!working}
        onPress={() =>
          run('attachPhotos', () =>
            sendPhotos(() => client.pickPhotos(object.id, 12)),
          )
        }
      />
    ),
    bestGuess: (
      <Button
        key="bestGuess"
        label="Make your best guess"
        variant="secondary"
        disabled={!!working}
        onPress={() => run('bestGuess', () => client.bestGuess(object.id))}
      />
    ),
    plateClear: (
      <Button
        key="plateClear"
        label="It’s actually clear"
        disabled={!!working}
        onPress={() => run('plateClear', () => client.plateClear(object.id))}
      />
    ),
    retry: (
      <Button
        key="retry"
        label="Try again"
        disabled={!!working}
        onPress={() => run('retry', () => client.start(object.id))}
      />
    ),
    scan: canScan ? (
      <Button
        key="scan"
        label="Scan it"
        systemImage="viewfinder"
        disabled={!!working}
        onPress={() =>
          run('scan', async () => {
            const runID = await capture.scan(object.id);
            return runID ? client.sendCapture(object.id, runID) : null;
          })
        }
      />
    ) : null,
    finishSending: (
      <Button
        key="finishSending"
        label={
          working === 'finishSending'
            ? 'Sending to your Mac…'
            : 'Finish sending'
        }
        variant="secondary"
        disabled={!!working}
        onPress={() =>
          run('finishSending', async () => {
            const runID = await capture.finished(object.id);
            return runID
              ? client.sendCapture(object.id, runID)
              : client.start(object.id);
          })
        }
      />
    ),
    makeIt: (
      <Button
        key="makeIt"
        label="Make it from the description"
        variant="secondary"
        disabled={!!working}
        onPress={() => run('makeIt', () => client.start(object.id))}
      />
    ),
  };

  return (
    <Screen title={view.title} onBack={onBack}>
      {object.current || object.state === 'touching-up' ? (
        <Renders client={client} object={object} />
      ) : null}
      {object.current?.sizeMm ? (
        <Text
          style={styles.size}
          accessibilityLabel={`${formatSize(object.current.sizeMm)
            .replace(/ × /g, ' by ')
            .replace('mm', 'millimetres')}`}
        >
          {formatSize(object.current.sizeMm)}
        </Text>
      ) : null}
      <Text
        accessibilityLiveRegion="polite"
        style={[styles.status, { color: TONE[view.tone] }]}
      >
        {view.status}
      </Text>
      {object.plate?.photo ? (
        <PlatePhoto client={client} object={object} />
      ) : null}
      {object.current?.summary && object.state !== 'touching-up' ? (
        <Text style={styles.summary} numberOfLines={4}>
          {object.current.summary}
        </Text>
      ) : null}
      {problem || error ? (
        <View accessibilityLiveRegion="assertive" style={styles.problem}>
          <Text style={styles.problemText}>{(problem ?? error)!.message}</Text>
          {(problem ?? error)!.kind === 'pairing' ? (
            <Button label="Connect to your Mac" onPress={onPair} />
          ) : !problem ? (
            <Button label="Try again" variant="secondary" onPress={load} />
          ) : null}
        </View>
      ) : null}
      <View style={styles.actions}>
        {view.actions.map(action => buttons[action])}
        {object.current && view.actions.includes('print') ? (
          <Button
            label="Turn it around"
            variant="secondary"
            systemImage="rotate.3d"
            disabled={!!working}
            onPress={() =>
              run('turn', async () => {
                await client.showModel(object);
                return null;
              })
            }
          />
        ) : null}
      </View>
      {view.actions.includes('correct') ? (
        <View style={styles.correct}>
          <Field
            label="Anything to fix?"
            hint="Say what’s wrong, like a size or a part that’s missing. It goes back for another touch-up."
            value={note}
            onChangeText={setNote}
            multiline
            maxLength={4000}
          />
          <Button
            label={working === 'correct' ? 'Sending…' : 'Send changes'}
            variant="secondary"
            disabled={!!working || !note.trim()}
            onPress={() =>
              run('correct', async () => {
                const next = await client.correct(object.id, note.trim());
                setNote('');
                return next;
              })
            }
          />
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  plateUnmeasured: { aspectRatio: 1 },
  plate: {
    backgroundColor: colors.viewport,
    borderRadius: radius.lg,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  plateText: { ...type.body, color: colors.viewportInk, padding: space.xl },
  size: {
    ...type.stat,
    fontSize: 40,
    lineHeight: 46,
    letterSpacing: -0.8,
    marginTop: space.lg,
  },
  status: { ...type.body, fontWeight: '600', marginTop: space.sm },
  summary: { ...type.body, color: colors.muted, marginTop: space.md },
  platePhoto: {
    width: '100%',
    aspectRatio: 4 / 3,
    borderRadius: radius.md,
    marginTop: space.md,
    backgroundColor: colors.viewport,
  },
  problem: {
    marginTop: space.lg,
    padding: space.lg,
    borderRadius: radius.md,
    backgroundColor: colors.failSoft,
    gap: space.md,
  },
  problemText: { ...type.body, color: colors.fail },
  actions: { marginTop: space.xl, gap: space.md },
  correct: { marginTop: space.xxl, gap: space.md },
});
