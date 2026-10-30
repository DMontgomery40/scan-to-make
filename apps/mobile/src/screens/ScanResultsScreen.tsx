import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import type { ScanProcessingJob } from '@scan-to-make/contracts';
import { Badge, Button, Card, Field, Notice, Screen } from '../ui/components';
import { colors, radius, space, type } from '../ui/theme';
import {
  failureOf,
  needsConnection,
  type ProjectAcknowledgment,
  type ScanServices,
  type ScanTarget,
} from './scanServices';
import {
  PRESETS,
  SIDE_NAMES,
  STAGE_LABELS,
  VIEW_LABELS,
  VIEW_ORDER,
  closeness,
  compare,
  describeDifference,
  emptyReference,
  failureCopy,
  formatMm,
  isActive,
  parseReference,
  referenceDraft,
  snapshotRevision,
  stageState,
  type Comparison,
  type ReferenceDraft,
  type ViewName,
} from './scanResultsModel';

type Phase =
  | { kind: 'loading' }
  | {
      kind: 'blocked';
      reason: 'connect' | 'earlier-version' | 'error';
      message: string;
    }
  | { kind: 'ready' }
  | { kind: 'starting' }
  | { kind: 'uncertain' }
  | { kind: 'job'; job: ScanProcessingJob };

const MAX_POLL_FAILURES = 3;

export function ScanResultsScreen({
  target,
  services,
  pollMs = 2000,
  onBack,
  onCompanion,
  onCloseUps,
  onMake,
}: {
  target: ScanTarget;
  services: ScanServices;
  pollMs?: number;
  onBack: () => void;
  onCompanion: () => void;
  onCloseUps: () => void;
  onMake: () => void;
}) {
  const { projectId } = target;
  const captureId = target.capture.captureId;
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [notice, setNotice] = useState<string | null>(null);
  const [pollStalled, setPollStalled] = useState(false);
  const [draft, setDraft] = useState<ReferenceDraft>(emptyReference);
  const [showErrors, setShowErrors] = useState(false);
  const ack = useRef<ProjectAcknowledgment | null>(null);
  const epoch = useRef(0);
  const busy = useRef(false);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    const token = ++epoch.current;
    const live = () => mounted.current && token === epoch.current;
    setPhase({ kind: 'loading' });
    setNotice(null);
    setPollStalled(false);
    try {
      const current = await services.acknowledge(projectId);
      if (!live()) return;
      ack.current = current;
      if (
        snapshotRevision(current.snapshot) !==
        target.capture.binding.projectRevision
      ) {
        setPhase({
          kind: 'blocked',
          reason: 'earlier-version',
          message: '',
        });
        return;
      }
      const jobId = await services.jobs.load(projectId, captureId);
      if (!live()) return;
      if (!jobId) {
        setPhase({ kind: 'ready' });
        return;
      }
      try {
        const job = await services.processing.status(
          projectId,
          captureId,
          current,
          jobId,
        );
        if (!live()) return;
        if (job.reference) setDraft(referenceDraft(job.reference));
        setPhase({ kind: 'job', job });
      } catch (error) {
        if (failureOf(error).status !== 404) throw error;
        await services.jobs.save(projectId, captureId, null);
        if (!live()) return;
        setNotice(
          'Your last check is no longer on your companion. Start a new one when you’re ready.',
        );
        setPhase({ kind: 'ready' });
      }
    } catch (error) {
      if (!live()) return;
      const failure = failureOf(error);
      setPhase({
        kind: 'blocked',
        reason: needsConnection(failure) ? 'connect' : 'error',
        message: failure.message,
      });
    }
  }, [services, projectId, captureId, target.capture.binding.projectRevision]);

  useEffect(() => {
    mounted.current = true;
    load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  // Follow a queued or running job until it reaches a final state.
  const activeJobId =
    phase.kind === 'job' && isActive(phase.job) ? phase.job.jobId : null;
  const [pollRound, setPollRound] = useState(0);
  useEffect(() => {
    if (!activeJobId || pollStalled || !ack.current) return;
    const token = epoch.current;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const tick = async () => {
      try {
        const job = await services.processing.status(
          projectId,
          captureId,
          ack.current!,
          activeJobId,
        );
        if (stopped || token !== epoch.current) return;
        failures = 0;
        setNotice(null);
        setPhase({ kind: 'job', job });
        if (isActive(job)) timer = setTimeout(tick, pollMs);
      } catch (error) {
        if (stopped || token !== epoch.current) return;
        failures++;
        if (failures >= MAX_POLL_FAILURES) {
          setPollStalled(true);
          setNotice(
            `We lost touch with your companion. It may still be working. ${
              failureOf(error).message
            }`,
          );
        } else {
          timer = setTimeout(tick, pollMs * (failures + 1));
        }
      }
    };
    timer = setTimeout(tick, pollMs);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [
    activeJobId,
    pollStalled,
    pollRound,
    services,
    projectId,
    captureId,
    pollMs,
  ]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') setPollRound(n => n + 1);
    });
    return () => subscription.remove();
  }, []);

  const parsed = parseReference(draft);
  const reference = parsed.state === 'valid' ? parsed.reference : null;

  const start = async () => {
    if (busy.current || !ack.current) return;
    if (parsed.state === 'invalid') {
      setShowErrors(true);
      return;
    }
    busy.current = true;
    setNotice(null);
    setPhase({ kind: 'starting' });
    try {
      const job = await services.processing.start(
        projectId,
        captureId,
        ack.current,
        reference ?? undefined,
      );
      await services.jobs.save(projectId, captureId, job.jobId);
      setPollStalled(false);
      setPhase({ kind: 'job', job });
    } catch (error) {
      const failure = failureOf(error);
      if (failure.code === 'ambiguous-start') {
        setPhase({ kind: 'uncertain' });
      } else if (needsConnection(failure)) {
        setPhase({
          kind: 'blocked',
          reason: 'connect',
          message: failure.message,
        });
      } else {
        setNotice(
          failure.status === 429
            ? 'Your companion is busy with another scan. Try again in a few minutes.'
            : failure.message,
        );
        setPhase({ kind: 'ready' });
      }
    } finally {
      busy.current = false;
    }
  };
  const confirmRestart = () =>
    Alert.alert(
      'Start another check?',
      'If the earlier check did start, your companion will run this scan twice. That’s safe, but it takes longer.',
      [
        { text: 'Not now', style: 'cancel' },
        { text: 'Start a new check', onPress: start },
      ],
    );
  const stop = (job: ScanProcessingJob) =>
    Alert.alert(
      'Stop checking this scan?',
      'Your companion will stop, and nothing from this check will be kept.',
      [
        { text: 'Keep going', style: 'cancel' },
        {
          text: 'Stop',
          style: 'destructive',
          onPress: async () => {
            if (busy.current || !ack.current) return;
            busy.current = true;
            try {
              const next = await services.processing.cancel(
                projectId,
                captureId,
                ack.current,
                job.jobId,
              );
              setPhase({ kind: 'job', job: next });
            } catch (error) {
              const failure = failureOf(error);
              setNotice(
                failure.code === 'ambiguous-cancel'
                  ? 'We couldn’t confirm the check stopped. We’ll keep showing its progress.'
                  : failure.message,
              );
              setPollStalled(false);
              setPollRound(n => n + 1);
            } finally {
              busy.current = false;
            }
          },
        },
      ],
    );
  const openModel = async (job: ScanProcessingJob, share: boolean) => {
    if (busy.current || !ack.current) return;
    busy.current = true;
    setNotice(null);
    try {
      await services.processing.openArtifact(
        projectId,
        captureId,
        ack.current,
        job,
        share ? 'repaired.stl' : 'repaired.obj',
        share,
      );
    } catch (error) {
      setNotice(failureOf(error).message);
    } finally {
      busy.current = false;
    }
  };

  const job = phase.kind === 'job' ? phase.job : null;
  const succeeded = job?.status === 'succeeded' ? job : null;
  const comparison = succeeded ? compare(succeeded, reference) : null;
  const canStart =
    phase.kind === 'ready' ||
    phase.kind === 'starting' ||
    job?.status === 'failed';

  let footer: React.ReactNode;
  if (succeeded) {
    footer = (
      <>
        <Button label="Choose what to make" onPress={onMake} />
        <Button
          label="Add close-up photos"
          variant="secondary"
          onPress={onCloseUps}
        />
      </>
    );
  } else if (canStart) {
    footer = (
      <Button
        label={
          phase.kind === 'starting'
            ? 'Starting…'
            : job
            ? 'Check again'
            : 'Check my scan'
        }
        disabled={phase.kind === 'starting'}
        onPress={start}
      />
    );
  } else if (job && isActive(job)) {
    footer = (
      <Button
        label="Stop checking"
        variant="secondary"
        onPress={() => stop(job)}
      />
    );
  }

  return (
    <Screen
      title="Scan results"
      eyebrow="YOUR SCAN / RESULTS"
      subtitle="See how your scan turned out, and how close it is to the real thing."
      onBack={onBack}
      footer={footer}
    >
      {phase.kind === 'loading' ? (
        <View
          style={styles.loading}
          accessible
          accessibilityLabel="Connecting to your companion"
        >
          <ActivityIndicator color={colors.muted} />
          <Text style={type.body}>Connecting to your companion…</Text>
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
          Scan checks run on your companion computer. Connect to it, then try
          again.
        </Notice>
      ) : null}
      {phase.kind === 'blocked' && phase.reason === 'earlier-version' ? (
        <Notice tone="pending" title="This scan is from an earlier version">
          You’ve changed this project since this scan was added, so it can’t be
          checked. Add it again from Project captures, or take a new scan.
        </Notice>
      ) : null}
      {phase.kind === 'blocked' && phase.reason === 'error' ? (
        <Notice
          tone="fail"
          title="Couldn’t open scan results"
          action={
            <Button label="Try again" variant="secondary" onPress={load} />
          }
        >
          {phase.message}
        </Notice>
      ) : null}

      {phase.kind === 'uncertain' ? (
        <Notice
          tone="pending"
          title="We couldn’t confirm the check started"
          action={
            <Button
              label="Start a new check"
              variant="secondary"
              onPress={confirmRestart}
            />
          }
        >
          Your companion may be working on it, but this phone didn’t get its
          reply, so it can’t follow along. Starting again could check the scan
          twice.
        </Notice>
      ) : null}

      {notice ? (
        <Notice
          tone="pending"
          action={
            pollStalled ? (
              <Button
                label="Check progress again"
                variant="secondary"
                onPress={() => {
                  setNotice(null);
                  setPollStalled(false);
                  setPollRound(n => n + 1);
                }}
              />
            ) : undefined
          }
        >
          {notice}
        </Notice>
      ) : null}

      {phase.kind === 'ready' || phase.kind === 'starting' ? (
        <Card>
          <Text style={type.heading}>Check your scan</Text>
          <Text style={type.body}>
            Your companion cleans up the scan, measures it and shows it from ten
            angles. This can take a few minutes.
          </Text>
          <Stages />
        </Card>
      ) : null}

      {job && isActive(job) ? <Progress job={job} /> : null}

      {job?.status === 'failed' ? (
        <Notice tone="fail" title={failureCopy(job).title}>
          {failureCopy(job).body}
        </Notice>
      ) : null}

      {succeeded ? (
        <>
          <View style={styles.readyRow}>
            <Badge label="Ready" tone="pass" />
            <Text style={[type.caption, styles.flex]}>
              Preview only. These results don’t confirm a printed part will fit.
            </Text>
          </View>
          <Gallery
            job={succeeded}
            services={services}
            target={target}
            ack={ack.current}
          />
          <SizeSection job={succeeded} comparison={comparison} />
        </>
      ) : null}

      {canStart || succeeded || phase.kind === 'uncertain' ? (
        <ReferenceForm
          draft={draft}
          onChange={value => {
            setDraft(value);
            setShowErrors(false);
          }}
          errors={
            parsed.state === 'invalid' && (showErrors || succeeded)
              ? parsed.errors
              : null
          }
          comparing={!!succeeded}
          disabled={phase.kind === 'starting'}
        />
      ) : null}

      {succeeded ? (
        <Card>
          <Text style={type.heading}>The cleaned-up model</Text>
          <Text style={type.caption}>
            Open it in 3D, or share the STL file with your own slicer.
          </Text>
          <Button
            label="View 3D model"
            variant="secondary"
            onPress={() => openModel(succeeded, false)}
          />
          <Button
            label="Share STL file"
            variant="secondary"
            onPress={() => openModel(succeeded, true)}
          />
        </Card>
      ) : null}

      {phase.kind !== 'loading' && !succeeded ? (
        <View style={styles.links}>
          <Text style={type.label}>MORE FOR THIS SCAN</Text>
          <Button
            label="Add close-up photos"
            variant="secondary"
            onPress={onCloseUps}
          />
          <Button
            label="Choose what to make"
            variant="secondary"
            onPress={onMake}
          />
        </View>
      ) : null}
    </Screen>
  );
}

function Stages({ job }: { job?: ScanProcessingJob }) {
  return (
    <View style={styles.stages}>
      {(['repair', 'measure', 'render'] as const).map((kind, index) => {
        const stage = job?.stages.find(s => s.kind === kind);
        const state = stage ? stageState(stage.status) : null;
        return (
          <View
            key={kind}
            style={styles.stage}
            accessible
            accessibilityLabel={`Step ${index + 1} of 3, ${STAGE_LABELS[kind]}${
              state ? `: ${state.label}` : ''
            }`}
          >
            <Text style={styles.stageNumber}>0{index + 1}</Text>
            <Text style={[type.body, styles.flex]}>{STAGE_LABELS[kind]}</Text>
            {state ? (
              stage?.status === 'running' ? (
                <ActivityIndicator color={colors.accent} />
              ) : (
                <Badge label={state.label} tone={state.tone} />
              )
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

function Progress({ job }: { job: ScanProcessingJob }) {
  const running = job.stages.findIndex(s => s.status === 'running');
  return (
    <Card>
      <Badge
        label={job.status === 'queued' ? 'In line' : 'Working'}
        tone={job.status === 'queued' ? 'neutral' : 'accent'}
      />
      <Text accessibilityLiveRegion="polite" style={type.heading}>
        {job.status === 'queued'
          ? 'Waiting for your companion'
          : running >= 0
          ? `Step ${running + 1} of 3: ${STAGE_LABELS[
              job.stages[running].kind
            ].toLowerCase()}`
          : 'Checking your scan'}
      </Text>
      <Stages job={job} />
      <Text style={type.caption}>
        This can take a few minutes. You can leave this screen. Your companion
        keeps working.
      </Text>
    </Card>
  );
}

function Gallery({
  job,
  services,
  target,
  ack,
}: {
  job: ScanProcessingJob;
  services: ScanServices;
  target: ScanTarget;
  ack: ProjectAcknowledgment | null;
}) {
  const { width } = useWindowDimensions();
  const [selected, setSelected] = useState<ViewName>(VIEW_ORDER[0]);
  const [uris, setUris] = useState<Partial<Record<ViewName, string>>>({});
  const [failed, setFailed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const resolve = services.imageUri;
  useEffect(() => {
    if (!resolve || !ack) return;
    let cancelled = false;
    (async () => {
      // One at a time: the companion serves a single request per project.
      for (const name of VIEW_ORDER) {
        try {
          const file = await services.processing.downloadArtifact(
            target.projectId,
            target.capture.captureId,
            ack,
            job,
            name,
          );
          const uri = await resolve(file);
          if (cancelled) return;
          if (uri) setUris(current => ({ ...current, [name]: uri }));
        } catch {
          if (cancelled) return;
          setFailed(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resolve, ack, job, services, target]);
  const open = async (name: ViewName) => {
    if (!ack) return;
    setMessage(null);
    try {
      await services.processing.openArtifact(
        target.projectId,
        target.capture.captureId,
        ack,
        job,
        name,
        false,
      );
    } catch (error) {
      setMessage(failureOf(error).message);
    }
  };
  const hero = uris[selected];
  const size = Math.min(width - space.xl * 2, 520);
  return (
    <View style={styles.gallery}>
      <Text style={type.heading}>Your scan from every side</Text>
      {resolve ? (
        <>
          <View
            style={[styles.hero, { width: size, height: size }]}
            accessible
            accessibilityRole="image"
            accessibilityLabel={`Cleaned-up scan, ${VIEW_LABELS[selected]} view`}
          >
            {hero ? (
              <Image
                source={{ uri: hero }}
                style={styles.heroImage}
                resizeMode="contain"
              />
            ) : (
              <ActivityIndicator color={colors.muted} />
            )}
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.thumbs}
          >
            {VIEW_ORDER.map(name => (
              <Pressable
                key={name}
                accessibilityRole="button"
                accessibilityLabel={`Show ${VIEW_LABELS[name]} view`}
                accessibilityState={{ selected: name === selected }}
                onPress={() => setSelected(name)}
                style={[
                  styles.thumb,
                  name === selected && styles.thumbSelected,
                ]}
              >
                {uris[name] ? (
                  <Image
                    source={{ uri: uris[name] }}
                    style={styles.thumbImage}
                  />
                ) : null}
                <Text style={styles.thumbLabel}>{VIEW_LABELS[name]}</Text>
              </Pressable>
            ))}
          </ScrollView>
          {failed ? (
            <Text style={type.caption}>
              Some views couldn’t be loaded. Open them one at a time below.
            </Text>
          ) : null}
        </>
      ) : null}
      {!resolve || failed ? (
        <View style={styles.tiles}>
          {VIEW_ORDER.map(name => (
            <Pressable
              key={name}
              accessibilityRole="button"
              accessibilityLabel={`Open ${VIEW_LABELS[name]} view`}
              onPress={() => open(name)}
              style={({ pressed }) => [styles.tile, pressed && styles.pressed]}
            >
              <Text style={styles.tileText}>{VIEW_LABELS[name]}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {message ? (
        <Text accessibilityLiveRegion="polite" style={styles.error}>
          {message}
        </Text>
      ) : null}
    </View>
  );
}

function SizeSection({
  job,
  comparison,
}: {
  job: ScanProcessingJob;
  comparison: Comparison | null;
}) {
  const { fontScale } = useWindowDimensions();
  const stacked = fontScale >= 1.3;
  const measured = [...(job.measuredPrincipalExtentsMm ?? [])].sort(
    (a, b) => b - a,
  );
  if (!comparison) {
    return (
      <Card>
        <Text style={type.heading}>Measured size</Text>
        <Text
          style={type.stat}
          accessibilityLabel={measured.map(formatMm).join(' by ')}
        >
          {measured.map(v => v.toFixed(1)).join(' × ')} mm
        </Text>
        <Text style={type.body}>
          Add the real size below to see how close your scan is.
        </Text>
      </Card>
    );
  }
  const verdict = closeness(comparison);
  return (
    <Card>
      <Text style={type.label}>HOW CLOSE IS IT?</Text>
      <View style={styles.verdict}>
        <Badge label={verdict.label} tone={verdict.tone} />
      </View>
      <Text accessibilityLiveRegion="polite" style={type.heading}>
        {verdict.summary}
      </Text>
      <Text style={type.body}>{verdict.advice}</Text>
      <View style={styles.table}>
        {!stacked ? (
          <View
            style={styles.row}
            importantForAccessibility="no-hide-descendants"
          >
            <Text style={[type.label, styles.sideCell]}>SIDE</Text>
            <Text style={[type.label, styles.numCell]}>SCAN</Text>
            <Text style={[type.label, styles.numCell]}>REAL</Text>
            <Text style={[type.label, styles.numCell]}>DIFF</Text>
          </View>
        ) : null}
        {SIDE_NAMES.map((side, index) => {
          const difference = describeDifference(comparison.errors[index]);
          return (
            <View
              key={side}
              style={[styles.row, styles.dataRow, stacked && styles.stackedRow]}
              accessible
              accessibilityLabel={`${side}: scan ${formatMm(
                comparison.measured[index],
              )}, real ${formatMm(comparison.reference[index])}, ${
                difference.words
              }`}
            >
              <Text style={[type.body, !stacked && styles.sideCell]}>
                {side}
              </Text>
              <Text style={[styles.num, !stacked && styles.numCell]}>
                {stacked ? 'Scan ' : ''}
                {formatMm(comparison.measured[index])}
              </Text>
              <Text style={[styles.num, !stacked && styles.numCell]}>
                {stacked ? 'Real ' : ''}
                {formatMm(comparison.reference[index])}
              </Text>
              <Text
                style={[
                  styles.num,
                  !stacked && styles.numCell,
                  Math.abs(comparison.errors[index]) > 1.5 && styles.numOff,
                ]}
              >
                {difference.short}
              </Text>
            </View>
          );
        })}
      </View>
      <Text style={type.caption}>
        Sides are matched longest to shortest, so this checks overall size, not
        small features like buttons or edges. Close-up photos help with those.
      </Text>
    </Card>
  );
}

function ReferenceForm({
  draft,
  onChange,
  errors,
  comparing,
  disabled,
}: {
  draft: ReferenceDraft;
  onChange: (draft: ReferenceDraft) => void;
  errors: (string | null)[] | null;
  comparing: boolean;
  disabled: boolean;
}) {
  const setSize = (index: number, value: string) => {
    const sizes = [...draft.sizes] as ReferenceDraft['sizes'];
    sizes[index] = value;
    onChange({ ...draft, sizes, source: undefined });
  };
  return (
    <Card>
      <Text style={type.heading}>The real size</Text>
      <Text style={type.body}>
        {comparing
          ? 'Change the real size to compare again. Your scan isn’t changed.'
          : 'Optional. If you know the real size, add it now or later. The maker’s published size is best.'}
      </Text>
      <Text style={type.label}>KNOWN PRODUCTS</Text>
      <View style={styles.presets}>
        {PRESETS.map(preset => {
          const chosen =
            draft.name === preset.name &&
            draft.sizes.every(
              (size, i) => Number(size) === preset.dimensionsMm[i],
            );
          return (
            <Pressable
              key={preset.name}
              disabled={disabled}
              accessibilityRole="button"
              accessibilityLabel={`Use ${
                preset.name
              }, ${preset.dimensionsMm.join(' by ')} millimetres`}
              accessibilityState={{ selected: chosen, disabled }}
              onPress={() =>
                onChange({
                  sizes: preset.dimensionsMm.map(
                    String,
                  ) as ReferenceDraft['sizes'],
                  name: preset.name,
                  source: preset.source,
                })
              }
              style={({ pressed }) => [
                styles.preset,
                chosen && styles.presetChosen,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.presetName}>{preset.name}</Text>
              <Text style={type.caption}>
                {preset.dimensionsMm.map(v => v.toFixed(1)).join(' × ')} mm
              </Text>
            </Pressable>
          );
        })}
      </View>
      <View style={styles.sizes}>
        {['Length', 'Width', 'Height'].map((label, index) => (
          <Field
            key={label}
            label={label}
            value={draft.sizes[index]}
            onChangeText={value => setSize(index, value)}
            keyboardType="decimal-pad"
            placeholder="0.0"
            suffix="mm"
            editable={!disabled}
            maxLength={8}
            error={errors?.[index]}
            containerStyle={styles.sizeCell}
          />
        ))}
      </View>
      <Field
        label="Product name (optional)"
        value={draft.name}
        onChangeText={name => onChange({ ...draft, name, source: undefined })}
        placeholder="AirPods Pro 2 case"
        editable={!disabled}
        maxLength={200}
        returnKeyType="done"
      />
      <Text style={type.caption}>
        Any order is fine. Sizes are matched longest to shortest.
      </Text>
      {draft.sizes.some(Boolean) || draft.name ? (
        <Button
          label="Clear real size"
          variant="secondary"
          disabled={disabled}
          onPress={() => onChange(emptyReference())}
        />
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  loading: {
    flexDirection: 'row',
    gap: space.md,
    alignItems: 'center',
    paddingVertical: space.lg,
  },
  readyRow: { flexDirection: 'row', gap: space.md, alignItems: 'center' },
  stages: { gap: space.sm, marginTop: space.xs },
  stage: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 44,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    paddingTop: space.sm,
  },
  stageNumber: {
    ...type.caption,
    color: colors.accent,
    fontVariant: ['tabular-nums'],
  },
  gallery: { gap: space.md },
  hero: {
    alignSelf: 'center',
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  heroImage: { width: '100%', height: '100%' },
  thumbs: { gap: space.sm, paddingVertical: space.xs },
  thumb: {
    width: 76,
    minHeight: 96,
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: 'transparent',
    backgroundColor: colors.surface,
    alignItems: 'center',
    padding: space.xs,
    gap: space.xs,
  },
  thumbSelected: { borderColor: colors.accent },
  thumbImage: { width: 64, height: 64, borderRadius: 10 },
  thumbLabel: { ...type.caption, textAlign: 'center' },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  tile: {
    flexGrow: 1,
    flexBasis: '45%',
    minHeight: 56,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.md,
  },
  tileText: { ...type.body, fontWeight: '600' },
  pressed: { opacity: 0.7 },
  error: { ...type.caption, color: colors.fail },
  verdict: { flexDirection: 'row' },
  table: { gap: 0, marginVertical: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  dataRow: {
    minHeight: 44,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    paddingVertical: space.sm,
  },
  stackedRow: { flexDirection: 'column', alignItems: 'flex-start', gap: 2 },
  sideCell: { flex: 1.4 },
  numCell: { flex: 1, textAlign: 'right' },
  num: { ...type.body, fontVariant: ['tabular-nums'] },
  numOff: { color: colors.fail, fontWeight: '600' },
  links: { gap: space.sm, marginTop: space.sm },
  presets: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  preset: {
    flexGrow: 1,
    flexBasis: '45%',
    minHeight: 56,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.background,
    gap: 2,
  },
  presetChosen: {
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
  },
  presetName: { ...type.body, fontWeight: '600' },
  sizes: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  sizeCell: { flexGrow: 1, flexBasis: 96 },
});
