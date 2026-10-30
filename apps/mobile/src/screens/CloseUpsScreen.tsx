import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  MAX_DETAIL_STILL_BYTES,
  MAX_DETAIL_STILLS_PER_CAPTURE,
  type DetailStill,
} from '@scan-to-make/contracts';
import type { CaptureFile } from '../capture/retainedCaptures';
import { Badge, Button, Card, Field, Notice, Screen } from '../ui/components';
import { colors, radius, space, type } from '../ui/theme';
import {
  failureOf,
  needsConnection,
  type PickedPhoto,
  type ProjectAcknowledgment,
  type RejectedPhoto,
  type ScanServices,
  type ScanTarget,
} from './scanServices';

const MEDIA_TYPES = ['image/jpeg', 'image/heic', 'image/png'];
const MEDIA_NAMES: Record<string, string> = {
  'image/jpeg': 'JPEG',
  'image/heic': 'HEIC',
  'image/png': 'PNG',
};

type DraftState = 'ready' | 'uploading' | 'failed' | 'uncertain';
type Draft = {
  photo: PickedPhoto;
  label: string;
  state: DraftState;
  message?: string;
};
// An unconfirmed upload is only retried after the list has been checked.
const uploadable = (d: Draft) => d.state === 'ready' || d.state === 'failed';
type Phase =
  | { kind: 'loading' }
  | { kind: 'blocked'; reason: 'connect' | 'error'; message: string }
  | { kind: 'ready' };

const same = (a: CaptureFile, b: CaptureFile) =>
  a.sha256 === b.sha256 &&
  a.byteLength === b.byteLength &&
  a.mediaType === b.mediaType;
export const megabytes = (bytes: number) =>
  `${(bytes / 1048576).toFixed(1)} MB`;

function rejectedSummary(rejected: RejectedPhoto[]) {
  const large = rejected.filter(r => r.reason === 'too-large').length;
  const kind = rejected.filter(r => r.reason === 'unsupported').length;
  const unreadable = rejected.length - large - kind;
  const parts = [
    large ? `${large} ${large === 1 ? 'is' : 'are'} over 25 MB` : '',
    kind
      ? `${kind} ${kind === 1 ? 'isn’t a' : 'aren’t'} JPEG, HEIC or PNG${
          kind === 1 ? ' photo' : ' photos'
        }`
      : '',
    unreadable ? `${unreadable} couldn’t be read from your library` : '',
  ].filter(Boolean);
  return `${rejected.length} ${
    rejected.length === 1 ? 'photo wasn’t' : 'photos weren’t'
  } added: ${parts.join(', ')}.`;
}

export function CloseUpsScreen({
  target,
  services,
  onBack,
  onCompanion,
}: {
  target: ScanTarget;
  services: ScanServices;
  onBack: () => void;
  onCompanion: () => void;
}) {
  const { projectId } = target;
  const captureId = target.capture.captureId;
  // Read contract values here, not at module scope: Metro's release inline
  // requires would otherwise resolve the contracts package as CommonJS, which
  // its exports map does not provide.
  const LIMIT = MAX_DETAIL_STILLS_PER_CAPTURE;
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [stills, setStills] = useState<DetailStill[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ack = useRef<ProjectAcknowledgment | null>(null);
  const staged = useRef<CaptureFile[]>([]);
  const running = useRef(false);

  const block = (error: unknown) => {
    const failure = failureOf(error);
    setPhase({
      kind: 'blocked',
      reason: needsConnection(failure) ? 'connect' : 'error',
      message: failure.message,
    });
  };
  const refresh = useCallback(async () => {
    if (!ack.current) return [];
    const list = await services.stills.list(projectId, captureId, ack.current);
    setStills(list);
    return list;
  }, [services, projectId, captureId]);
  const load = useCallback(async () => {
    setPhase({ kind: 'loading' });
    setNotice(null);
    try {
      ack.current = await services.acknowledge(projectId);
      await refresh();
      setPhase({ kind: 'ready' });
    } catch (error) {
      block(error);
    }
  }, [services, projectId, refresh]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(
    () => () => {
      // Local copies are only needed until upload.
      if (staged.current.length) {
        services.picker.discard(staged.current).catch(() => {});
      }
    },
    [services],
  );

  const room = LIMIT - stills.length - drafts.length;
  const full = stills.length >= LIMIT;

  async function exclusive(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await action();
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  const add = () =>
    exclusive(async () => {
      setNotice(null);
      if (room <= 0) return;
      try {
        const { photos, rejected } = await services.picker.pick(room);
        staged.current.push(...photos);
        const fresh: Draft[] = [];
        let duplicates = 0;
        const extra: RejectedPhoto[] = [...rejected];
        for (const photo of photos) {
          if (
            stills.some(s => same(s, photo)) ||
            drafts.some(d => same(d.photo, photo)) ||
            fresh.some(d => same(d.photo, photo))
          ) {
            duplicates++;
          } else if (photo.byteLength > MAX_DETAIL_STILL_BYTES) {
            extra.push({ reason: 'too-large', byteLength: photo.byteLength });
          } else if (!MEDIA_TYPES.includes(photo.mediaType)) {
            extra.push({ reason: 'unsupported' });
          } else {
            fresh.push({ photo, label: '', state: 'ready' });
          }
        }
        const kept = fresh.slice(0, Math.max(0, room));
        setDrafts(current => [...current, ...kept]);
        setPreviews(current => {
          const next = { ...current };
          for (const draft of kept) next[draft.photo.sha256] = draft.photo.uri;
          return next;
        });
        const notes = [
          extra.length ? rejectedSummary(extra) : '',
          duplicates
            ? `${duplicates} ${
                duplicates === 1 ? 'photo was' : 'photos were'
              } already here.`
            : '',
          fresh.length > kept.length
            ? `Only ${LIMIT} close-ups fit with one scan.`
            : '',
        ].filter(Boolean);
        if (notes.length) setNotice(notes.join(' '));
      } catch (error) {
        setNotice(failureOf(error).message);
      }
    });

  const update = (sha256: string, change: Partial<Draft>) =>
    setDrafts(current =>
      current.map(d => (d.photo.sha256 === sha256 ? { ...d, ...change } : d)),
    );

  const upload = () =>
    exclusive(async () => {
      if (!ack.current) return;
      setNotice(null);
      for (const draft of drafts.filter(uploadable)) {
        const sha = draft.photo.sha256;
        update(sha, { state: 'uploading', message: undefined });
        try {
          const label = draft.label.trim();
          const still = await services.stills.upload(
            projectId,
            captureId,
            ack.current,
            draft.photo,
            label ? label : undefined,
          );
          setStills(current => [...current, still]);
          setDrafts(current => current.filter(d => d.photo.sha256 !== sha));
        } catch (error) {
          const failure = failureOf(error);
          if (needsConnection(failure)) {
            update(sha, { state: 'ready' });
            block(error);
            return;
          }
          if (failure.code === 'ambiguous-upload') {
            // The photo may have landed: look before offering a retry.
            const list = await refresh().catch(() => null);
            if (list?.some(s => same(s, draft.photo))) {
              setDrafts(current => current.filter(d => d.photo.sha256 !== sha));
            } else {
              update(sha, {
                state: 'uncertain',
                message:
                  'We couldn’t confirm this photo was added, and it isn’t in the list yet. Check again before retrying.',
              });
            }
            continue;
          }
          if (failure.code === 'still-limit') {
            update(sha, { state: 'ready' });
            await refresh().catch(() => null);
            setNotice(
              `This scan already has ${LIMIT} close-ups. Remove one to add another.`,
            );
            return;
          }
          update(sha, { state: 'failed', message: failure.message });
        }
      }
    });

  const removeDraft = (draft: Draft, discard = false) => {
    setDrafts(current =>
      current.filter(d => d.photo.sha256 !== draft.photo.sha256),
    );
    if (discard) {
      staged.current = staged.current.filter(f => !same(f, draft.photo));
      services.picker.discard([draft.photo]).catch(() => {});
    }
  };
  const removeStill = (still: DetailStill, index: number) =>
    Alert.alert(
      `Remove close-up ${index + 1}?`,
      'It will be deleted from this scan on your companion.',
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () =>
            exclusive(async () => {
              if (!ack.current) return;
              setNotice(null);
              try {
                await services.stills.remove(
                  projectId,
                  captureId,
                  ack.current,
                  still.id,
                );
                setStills(current => current.filter(s => s.id !== still.id));
              } catch (error) {
                const failure = failureOf(error);
                if (needsConnection(failure)) return block(error);
                setNotice(
                  failure.code === 'ambiguous-delete'
                    ? 'We couldn’t confirm it was removed. The list below shows what your companion has now.'
                    : failure.message,
                );
                await refresh().catch(() => null);
              }
            }),
        },
      ],
    );
  const view = (still: DetailStill) =>
    exclusive(async () => {
      if (!ack.current) return;
      try {
        await services.stills.openFile(
          projectId,
          captureId,
          ack.current,
          still,
          false,
        );
      } catch (error) {
        setNotice(failureOf(error).message);
      }
    });

  const pending = drafts.filter(uploadable).length;
  const uploading = drafts.some(d => d.state === 'uploading');
  const ready = phase.kind === 'ready';
  return (
    <Screen
      title="Close-ups"
      eyebrow="YOUR SCAN / DETAILS"
      subtitle="Scans capture the overall shape well but blur small things like ports, buttons and edges. Close-up photos keep those details with your scan."
      onBack={uploading ? undefined : onBack}
      footer={
        ready && drafts.length ? (
          <Button
            label={
              uploading
                ? 'Adding…'
                : `Add ${pending} ${pending === 1 ? 'photo' : 'photos'} to scan`
            }
            disabled={busy || !pending}
            onPress={upload}
          />
        ) : undefined
      }
    >
      {phase.kind === 'loading' ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.muted} />
          <Text style={type.body}>Loading your close-ups…</Text>
        </View>
      ) : null}
      {phase.kind === 'blocked' && phase.reason === 'connect' ? (
        <Notice
          tone="pending"
          title="Connect your companion"
          action={
            <>
              <Button label="Connect companion" onPress={onCompanion} />
              <Button label="Try again" variant="secondary" onPress={load} />
            </>
          }
        >
          Close-ups are kept with your scan on your companion computer. Connect
          to it, then try again.
        </Notice>
      ) : null}
      {phase.kind === 'blocked' && phase.reason === 'error' ? (
        <Notice
          tone="fail"
          title="Couldn’t load close-ups"
          action={
            <Button label="Try again" variant="secondary" onPress={load} />
          }
        >
          {phase.message}
        </Notice>
      ) : null}

      {ready ? (
        <>
          <View style={styles.counter}>
            <Text
              style={type.heading}
              accessibilityLabel={`${stills.length} of ${LIMIT} close-ups added`}
            >
              {stills.length} of {LIMIT}
            </Text>
            <Text style={type.caption}>
              Up to {LIMIT} photos, 25 MB each. JPEG, HEIC or PNG.
            </Text>
          </View>
          {full ? (
            <Notice tone="pending" title="That’s the limit">
              {`You’ve added ${LIMIT} close-ups to this scan. Remove one to add another.`}
            </Notice>
          ) : (
            <Button
              label="Choose photos"
              variant={drafts.length ? 'secondary' : 'primary'}
              disabled={busy || room <= 0}
              accessibilityHint={
                room <= 0
                  ? 'Add or remove the photos you’ve chosen first'
                  : 'Opens your photo library'
              }
              onPress={add}
            />
          )}
          {notice ? <Notice tone="pending">{notice}</Notice> : null}

          {!stills.length && !drafts.length ? (
            <Card>
              <Text style={type.heading}>No close-ups yet</Text>
              <Text style={type.body}>
                Good close-ups are sharp, well lit and fill the frame with one
                detail.
              </Text>
              {[
                'Ports and openings',
                'Buttons and switches',
                'Edges, lips and hinges',
              ].map(tip => (
                <View key={tip} style={styles.tip}>
                  <View style={styles.tipDot} />
                  <Text style={type.body}>{tip}</Text>
                </View>
              ))}
            </Card>
          ) : null}

          {drafts.length ? (
            <View style={styles.section}>
              <Text style={type.label}>READY TO ADD</Text>
              {drafts.map((draft, index) => (
                <Card key={draft.photo.sha256} style={styles.photoCard}>
                  <View style={styles.photoRow}>
                    <Image
                      source={{ uri: draft.photo.uri }}
                      style={styles.photo}
                      accessibilityLabel={`Chosen photo ${index + 1}`}
                    />
                    <View style={styles.photoInfo}>
                      <Text style={type.body}>Photo {index + 1}</Text>
                      <Text style={type.caption}>
                        {megabytes(draft.photo.byteLength)} ·{' '}
                        {MEDIA_NAMES[draft.photo.mediaType]}
                      </Text>
                      {draft.state === 'uploading' ? (
                        <View style={styles.uploading}>
                          <ActivityIndicator color={colors.accent} />
                          <Text style={type.caption}>Adding…</Text>
                        </View>
                      ) : draft.state === 'failed' ? (
                        <Badge label="Not added" tone="fail" />
                      ) : draft.state === 'uncertain' ? (
                        <Badge label="Not confirmed" tone="pending" />
                      ) : null}
                    </View>
                  </View>
                  <Field
                    label={`What does photo ${index + 1} show?`}
                    hint="Optional"
                    value={draft.label}
                    onChangeText={label =>
                      update(draft.photo.sha256, { label })
                    }
                    placeholder="USB-C port"
                    maxLength={200}
                    editable={draft.state !== 'uploading'}
                    returnKeyType="done"
                  />
                  {draft.message ? (
                    <Text accessibilityLiveRegion="polite" style={styles.error}>
                      {draft.message}
                    </Text>
                  ) : null}
                  {draft.state === 'uncertain' ? (
                    <Button
                      label="Check the list again"
                      variant="secondary"
                      disabled={busy}
                      onPress={() =>
                        exclusive(async () => {
                          const list = await refresh().catch(() => null);
                          if (list?.some(s => same(s, draft.photo))) {
                            removeDraft(draft);
                          } else {
                            update(draft.photo.sha256, {
                              state: 'ready',
                              message: 'Not in the list. You can add it again.',
                            });
                          }
                        })
                      }
                    />
                  ) : null}
                  <Button
                    label="Don’t add"
                    accessibilityLabel={`Don’t add photo ${index + 1}`}
                    variant="secondary"
                    disabled={busy}
                    onPress={() => removeDraft(draft, true)}
                  />
                </Card>
              ))}
            </View>
          ) : null}

          {stills.length ? (
            <View style={styles.section}>
              <Text style={type.label}>ADDED TO THIS SCAN</Text>
              {stills.map((still, index) => (
                <Card key={still.id} style={styles.photoCard}>
                  <View style={styles.photoRow}>
                    {previews[still.sha256] ? (
                      <Image
                        source={{ uri: previews[still.sha256] }}
                        style={styles.photo}
                        accessibilityLabel={`Close-up ${index + 1}`}
                      />
                    ) : (
                      <View style={[styles.photo, styles.placeholder]}>
                        <Text style={styles.placeholderText}>{index + 1}</Text>
                      </View>
                    )}
                    <View style={styles.photoInfo}>
                      <Text style={type.body}>
                        {still.label ?? `Close-up ${index + 1}`}
                      </Text>
                      <Text style={type.caption}>
                        {still.label ? `Close-up ${index + 1} · ` : ''}
                        {megabytes(still.byteLength)} ·{' '}
                        {MEDIA_NAMES[still.mediaType]}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.actions}>
                    <View style={styles.action}>
                      <Button
                        label="View"
                        accessibilityLabel={`View close-up ${index + 1}`}
                        variant="secondary"
                        disabled={busy}
                        onPress={() => view(still)}
                      />
                    </View>
                    <View style={styles.action}>
                      <Button
                        label="Remove"
                        accessibilityLabel={`Remove close-up ${index + 1}`}
                        variant="secondary"
                        disabled={busy}
                        onPress={() => removeStill(still, index)}
                      />
                    </View>
                  </View>
                </Card>
              ))}
            </View>
          ) : null}
          <Text style={type.caption}>
            Photos come from your library and are only sent to your companion.
          </Text>
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  loading: {
    flexDirection: 'row',
    gap: space.md,
    alignItems: 'center',
    paddingVertical: space.lg,
  },
  counter: { gap: space.xs },
  tip: { flexDirection: 'row', gap: space.md, alignItems: 'center' },
  tipDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.accent,
  },
  section: { gap: space.md },
  photoCard: { gap: space.md },
  photoRow: { flexDirection: 'row', gap: space.md, alignItems: 'center' },
  photo: {
    width: 72,
    height: 72,
    borderRadius: radius.md,
    backgroundColor: colors.line,
  },
  placeholder: { alignItems: 'center', justifyContent: 'center' },
  placeholderText: { ...type.heading, color: colors.muted },
  photoInfo: { flex: 1, gap: space.xs, alignItems: 'flex-start' },
  uploading: { flexDirection: 'row', gap: space.sm, alignItems: 'center' },
  error: { ...type.caption, color: colors.fail },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  action: { flexGrow: 1, flexBasis: 120 },
});
