import React, { useEffect, useState } from 'react';
import { Share, StyleSheet, Text, View } from 'react-native';
import {
  mockCaptureSource,
  nativeCaptureSource,
  type CaptureSource,
} from '../capture/captureSource';
import { RUN_TARGET_MS, useSpikeRun } from '../spike/useSpikeRun';
import type { SpikeReport } from '../spike/d004';
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
  return (
    <Screen
      title="Capture spike"
      subtitle="D004: two-minute AR session, scored against the agreed pass criteria."
      onBack={onBack}
    >
      {choice.status === 'checking' ? (
        <Text style={type.caption}>Checking for AR…</Text>
      ) : (
        <SpikeRunner source={choice.source} note={choice.note} />
      )}
    </Screen>
  );
}

function SpikeRunner({
  source,
  note,
}: {
  source: CaptureSource;
  note: string;
}) {
  const { state, start, stop } = useSpikeRun(source);
  const { phase, latest, session, report, errors } = state;
  const running = phase === 'starting' || phase === 'running';
  const fps = latest ? latest.frames / (latest.intervalMs / 1000) : null;

  return (
    <>
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
        </View>
        {errors.length > 0 ? (
          <Text style={styles.error}>{errors[errors.length - 1]}</Text>
        ) : null}
        <View style={styles.actions}>
          {running ? (
            <Button label="Stop and score" variant="secondary" onPress={stop} />
          ) : (
            <Button
              label={report ? 'Run again' : 'Start 2-minute run'}
              onPress={start}
            />
          )}
        </View>
      </Card>

      {report ? <ReportCard report={report} /> : null}
    </>
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
