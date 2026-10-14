import React, { useEffect, useState } from 'react';
import {
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
  Platform,
} from 'react-native';
import {
  mockCaptureSource,
  nativeCaptureSource,
  type CaptureSource,
} from '../capture/captureSource';
import { RUN_TARGET_MS, useSpikeRun } from '../spike/useSpikeRun';
import {
  hasAnchoredPreview,
  D004_THRESHOLDS,
  type SpikeReport,
  type AnchorObservation,
} from '../spike/d004';
import { ScanCapturePreview } from '../capture/ScanCapturePreview';
import { Button, Card, Screen, Stat, VerdictPill } from '../ui/components';
import { colors, space, type } from '../ui/theme';

type SourceChoice =
  | { status: 'checking' }
  | { status: 'ready'; source: CaptureSource; note: string };

function useCaptureSource(override?: CaptureSource): SourceChoice {
  const [choice, setChoice] = useState<SourceChoice>(
    override
      ? { status: 'ready', source: override, note: 'Injected source' }
      : { status: 'checking' },
  );
  useEffect(() => {
    if (override) {
      return;
    }
    let cancelled = false;
    const native = nativeCaptureSource();
    const pick = (source: CaptureSource, note: string) => {
      if (!cancelled) {
        setChoice({ status: 'ready', source, note });
      }
    };
    if (!native) {
      pick(
        mockCaptureSource(),
        'Native module not in this build. Using mock samples.',
      );
    } else {
      native
        .isSupported()
        .catch(() => false)
        .then(ok =>
          ok
            ? pick(native, 'Native AR session')
            : pick(
                mockCaptureSource(),
                'AR not supported here. Using mock samples.',
              ),
        );
    }
    return () => {
      cancelled = true;
    };
  }, [override]);
  return choice;
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function SpikeScreen({
  onBack,
  sourceOverride,
}: {
  onBack: () => void;
  sourceOverride?: CaptureSource;
}) {
  const choice = useCaptureSource(sourceOverride);
  return choice.status === 'checking' ? (
    <Screen title="Capture spike" onBack={onBack}>
      <Text style={type.caption}>Checking for AR…</Text>
    </Screen>
  ) : (
    <SpikeRunner source={choice.source} note={choice.note} onBack={onBack} />
  );
}

function SpikeRunner({
  source,
  note,
  onBack,
}: {
  source: CaptureSource;
  note: string;
  onBack: () => void;
}) {
  const { state, start, stop, observe } = useSpikeRun(source);
  const { phase, latest, session, report, errors } = state;
  const running = phase === 'starting' || phase === 'running';
  const fps = latest ? latest.frames / (latest.intervalMs / 1000) : null;

  return (
    <Screen
      title="Capture spike"
      subtitle="D004: visible capture and a known stability probe. Not a fitted part."
      onBack={onBack}
      footer={
        running ? (
          <Button label="Stop and score" variant="secondary" onPress={stop} />
        ) : (
          <Button
            label={report ? 'Run again' : 'Start 2-minute run'}
            onPress={start}
          />
        )
      }
    >
      {source.kind === 'native' && Platform.OS === 'ios' ? (
        <>
          <ScanCapturePreview style={styles.preview} />
          <Text style={type.caption}>
            {running
              ? latest?.probeMessage ??
                'Center a mapped surface, then tap the preview. Scored time starts at probe placement.'
              : 'Camera is stopped. Start explicitly, then center a detected surface and tap to place the 10 mm orange probe.'}
          </Text>
        </>
      ) : (
        <Text style={styles.warn}>
          Visible native preview is unavailable here. No camera is started by
          this screen.
        </Text>
      )}
      <Card>
        <Text style={type.label}>SOURCE</Text>
        <Text style={type.body}>{note}</Text>
        {session ? (
          <Text style={type.caption}>
            {session.framework} · {session.deviceModel} · {session.osVersion}
            {' · '}depth {session.depthEnabled ? 'on' : 'off'} · mesh{' '}
            {session.meshEnabled ? 'on' : 'off'}
          </Text>
        ) : null}
        {source.kind === 'mock' ? (
          <Text style={styles.warn}>
            Mock runs are sped up and always score “Not yet known”.
          </Text>
        ) : null}
      </Card>

      <Card>
        <View style={styles.stats}>
          <Stat
            label="Elapsed"
            value={`${clock(latest?.tMs ?? 0)} / ${clock(RUN_TARGET_MS)}`}
          />
          <Stat
            label="Frame rate"
            value={fps === null ? '—' : `${fps.toFixed(1)} fps`}
          />
          <Stat label="Thermal" value={latest?.thermal ?? '—'} />
          <Stat label="Tracking" value={latest?.tracking ?? '—'} />
          <Stat
            label="Rendered frames / window"
            value={String(latest?.renderedFrames ?? '—')}
          />
          <Stat
            label="Observed depth frames"
            value={String(latest?.depthFrames ?? '—')}
          />
          <Stat
            label="Observed mesh anchors"
            value={String(latest?.meshAnchorCount ?? '—')}
          />
          <Stat
            label="Probe rendered / window"
            value={String(latest?.renderedProbeFrames ?? '—')}
          />
        </View>
        {errors.length > 0 ? (
          <Text style={styles.error}>{errors[errors.length - 1]}</Text>
        ) : null}
      </Card>

      {report ? (
        <>
          <Observation
            key={report.createdAt}
            report={report}
            onRecord={observe}
          />
          <ReportCard report={report} />
        </>
      ) : null}
    </Screen>
  );
}

function Observation({
  report,
  onRecord,
}: {
  report: SpikeReport;
  onRecord: (value: AnchorObservation) => void;
}) {
  const [confirmed, setConfirmed] = useState<boolean | null>(null);
  const [drift, setDrift] = useState('');
  const [method, setMethod] = useState('');
  const validNumber =
    !drift.trim() ||
    (Number.isFinite(Number(drift)) && Number(drift) >= 0 && !!method.trim());
  if (
    !hasAnchoredPreview(report) ||
    report.summary.scoredSeconds < D004_THRESHOLDS.minRunSeconds
  ) {
    return (
      <Text style={type.caption}>
        No complete visible native probe run to observe. Mock, hidden,
        unattached or unrendered content cannot qualify.
      </Text>
    );
  }
  return (
    <Card>
      <Text style={type.heading}>What did you observe?</Text>
      <Text style={type.caption}>
        During the full scored window, did the orange probe remain attached to
        the surface? This is qualitative runtime stability, not mechanical fit.
      </Text>
      <Button
        label="Stayed attached"
        variant="secondary"
        onPress={() => setConfirmed(true)}
      />
      <Button
        label="Slipped from surface"
        variant="secondary"
        onPress={() => setConfirmed(false)}
      />
      <Button
        label="Not observed"
        variant="secondary"
        onPress={() => setConfirmed(null)}
      />
      <Text style={type.body}>
        {confirmed === null
          ? 'Not observed'
          : confirmed
          ? 'Stayed attached'
          : 'Slipped from surface'}
      </Text>
      <Text style={type.caption}>
        Optional measured maximum drift (mm) and external measurement method.
        Leave blank if unmeasured; ARAnchor transforms are not drift
        measurements.
      </Text>
      <TextInput
        accessibilityLabel="Measured maximum drift, millimetres"
        value={drift}
        onChangeText={setDrift}
        keyboardType="decimal-pad"
        style={styles.input}
      />
      <TextInput
        accessibilityLabel="Drift measurement method"
        value={method}
        onChangeText={setMethod}
        multiline
        style={styles.input}
      />
      {!validNumber ? (
        <Text style={styles.error}>
          Enter a finite nonnegative measurement and its method, or leave the
          measurement blank.
        </Text>
      ) : null}
      <Button
        label="Record observation"
        disabled={!validNumber}
        onPress={() =>
          onRecord({
            observerConfirmed: confirmed,
            maxDriftMm: drift.trim() ? Number(drift) : null,
            measurementMethod: method.trim(),
          })
        }
      />
    </Card>
  );
}

function ReportCard({ report }: { report: SpikeReport }) {
  const share = () =>
    Share.share({
      title: 'D004 spike report',
      message: JSON.stringify(report, null, 2),
    }).catch(() => {});

  return (
    <Card>
      <View style={styles.reportHeader}>
        <Text style={type.heading}>Result</Text>
        <VerdictPill verdict={report.verdict} />
      </View>
      {report.criteria.map(c => (
        <View key={c.id} style={styles.criterion}>
          <View style={styles.criterionHeader}>
            <Text style={[type.body, styles.criterionLabel]}>{c.label}</Text>
            <VerdictPill verdict={c.verdict} />
          </View>
          <Text style={type.caption}>{c.detail}</Text>
        </View>
      ))}
      <Text style={type.body}>
        {report.quantitativeDrift.label}: {report.quantitativeDrift.verdict}
      </Text>
      <Text style={type.caption}>{report.quantitativeDrift.detail}</Text>
      <View style={styles.actions}>
        <Button
          label="Share report (JSON)"
          variant="secondary"
          onPress={share}
        />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  preview: {
    height: 240,
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: colors.ink,
  },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    padding: 12,
    color: colors.ink,
  },
  stats: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    rowGap: space.lg,
    columnGap: space.md,
  },
  actions: { marginTop: space.md },
  warn: { ...type.caption, color: colors.pending },
  error: { ...type.caption, color: colors.fail, marginTop: space.md },
  reportHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  criterion: {
    paddingTop: space.md,
    marginTop: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    gap: space.xs,
  },
  criterionHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
  },
  criterionLabel: { flex: 1, fontWeight: '600' },
});
