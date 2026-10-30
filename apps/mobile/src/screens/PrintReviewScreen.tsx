import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { CaptureFile } from '../capture/retainedCaptures';
import {
  Badge,
  Button,
  Card,
  Notice,
  Screen,
  type Tone,
} from '../ui/components';
import { colors, space, type } from '../ui/theme';
import {
  failureOf,
  needsConnection,
  notAvailable,
  type Failure,
  type ProjectAcknowledgment,
} from './scanServices';
import {
  newJobId,
  type PreparedPrint,
  type PrintabilityReport,
  type PrintAttempt,
  type PrintReviewServices,
} from './printReviewServices';
import {
  VERDICTS,
  bedLabel,
  profileLine,
  reasonTexts,
  summaryRows,
  trayLabel,
  warningTexts,
} from './printReviewModel';

type Blocked = 'connect' | 'unavailable' | 'unreachable' | 'changed' | 'error';
type Phase =
  | { kind: 'loading' }
  | { kind: 'blocked'; reason: Blocked; message: string }
  | { kind: 'ready' }
  | { kind: 'preparing' }
  | { kind: 'not-printable'; report?: PrintabilityReport; message: string }
  | { kind: 'needs-supports'; report?: PrintabilityReport }
  | { kind: 'prepared'; print: PreparedPrint }
  | { kind: 'sending'; print: PreparedPrint }
  | { kind: 'checking'; print: PreparedPrint }
  | { kind: 'unconfirmed'; print: PreparedPrint }
  | { kind: 'sent'; attempt: PrintAttempt };

const UNREACHABLE = new Set([
  'network',
  'timeout',
  'unavailable',
  'companion-unavailable',
]);
const unreachable = (f: Failure) =>
  (!!f.code && UNREACHABLE.has(f.code)) || (f.status ?? 0) >= 500;
function blockedReason(f: Failure): Blocked {
  if (needsConnection(f)) return 'connect';
  if (notAvailable(f)) return 'unavailable';
  if (f.code === 'project-changed') return 'changed';
  if (unreachable(f)) return 'unreachable';
  return 'error';
}

function attemptText(attempt: PrintAttempt) {
  switch (attempt.resolution) {
    case 'finished':
      return 'Your companion marked this print finished.';
    case 'cancelled':
      return 'Your companion marked this print cancelled.';
    case 'rejected':
      return 'Your companion didn’t start this print. Check the printer and its screen.';
  }
  switch (attempt.outcome) {
    case 'started':
      return 'Your companion reports the print started. Stay nearby for the first layer.';
    case 'unconfirmed':
    case 'uncertain':
      return 'Your companion couldn’t confirm the print started. Check the printer before trying anything else.';
  }
  return 'Your companion checks the printer, nozzle and filament once more before it starts. Stay nearby for the first layer.';
}

export function PrintReviewScreen({
  projectId,
  design,
  designName,
  services,
  onBack,
  onCompanion,
}: {
  projectId: string;
  /** The project's accepted design, by exact identity. */
  design: CaptureFile;
  designName: string;
  services: PrintReviewServices;
  onBack: () => void;
  onCompanion: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [notice, setNotice] = useState<{ tone: Tone; text: string } | null>(
    null,
  );
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const ack = useRef<ProjectAcknowledgment | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  const show = (next: Phase) => {
    if (mounted.current) setPhase(next);
  };
  const block = (error: unknown) => {
    const f = failureOf(error);
    show({ kind: 'blocked', reason: blockedReason(f), message: f.message });
  };

  async function prepare(allowSupports: boolean) {
    if (!ack.current) return;
    setNotice(null);
    // The job ID names this exact request: the same request reuses it, so a
    // retry returns the job already prepared instead of slicing twice.
    const kept = await services.jobs.load(projectId, design.sha256);
    const same = kept && kept.allowSupports === allowSupports;
    const jobId = same ? kept.jobId : newJobId();
    await services.jobs.save(projectId, design.sha256, {
      jobId,
      allowSupports,
      prepared: same ? kept.prepared : false,
    });
    show({ kind: 'preparing' });
    try {
      const print = await services.prepare(projectId, ack.current, {
        jobId,
        design,
        allowSupports,
      });
      await services.jobs.save(projectId, design.sha256, {
        jobId,
        allowSupports,
        prepared: true,
      });
      if (!mounted.current) return;
      setChecked({});
      show({ kind: 'prepared', print });
    } catch (error) {
      const f = failureOf(error);
      const report = (error as { report?: PrintabilityReport })?.report;
      if (f.code === 'printability-failed') {
        show({ kind: 'not-printable', report, message: f.message });
      } else if (f.code === 'supports-required') {
        show({ kind: 'needs-supports', report });
      } else if (
        blockedReason(f) !== 'error' &&
        blockedReason(f) !== 'unreachable'
      ) {
        block(error);
      } else {
        setNotice({
          tone: 'fail',
          text: unreachable(f)
            ? 'Your companion didn’t answer. Check it’s running, then try again. Trying again won’t prepare the print twice.'
            : f.message,
        });
        show({ kind: 'ready' });
      }
    }
  }

  /** After an unclear send, only a successful status read decides. */
  async function verify(print: PreparedPrint) {
    if (!ack.current) return;
    show({ kind: 'checking', print });
    try {
      const attempt = await services.attempt(
        projectId,
        ack.current,
        print.jobId,
      );
      if (attempt.intent) {
        show({ kind: 'sent', attempt });
      } else {
        setNotice({
          tone: 'pending',
          text: 'Your companion doesn’t have it, so nothing was sent. You can send it again.',
        });
        show({ kind: 'prepared', print });
      }
    } catch {
      show({ kind: 'unconfirmed', print });
    }
  }

  async function send(print: PreparedPrint) {
    if (busy.current || !ack.current) return;
    busy.current = true;
    setNotice(null);
    show({ kind: 'sending', print });
    try {
      const intent = await services.claimIntent(
        projectId,
        ack.current,
        print.jobId,
        { jobSha256: print.jobSha256, confirmed: true },
      );
      show({ kind: 'sent', attempt: { intent } });
    } catch (error) {
      const f = failureOf(error);
      const retry = (text: string) => {
        setNotice({ tone: 'fail', text });
        show({ kind: 'prepared', print });
      };
      if (f.code === 'printer-offline') {
        retry(
          'Your printer seems to be off or offline. Turn it on, check it’s on the same network as your companion, then send again.',
        );
      } else if (f.code === 'printer-busy') {
        retry(
          'Your printer is busy with another job. Send this again when it’s finished.',
        );
      } else if (f.code === 'approval-expired') {
        retry(
          'That took too long to go through. Check the list and send again.',
        );
      } else if (
        needsConnection(f) ||
        notAvailable(f) ||
        f.code === 'project-changed'
      ) {
        block(error);
      } else {
        // Lost replies, already-sent and anything unexpected may have reached
        // the companion: look before offering to send again.
        await verify(print);
      }
    } finally {
      busy.current = false;
    }
  }

  async function load() {
    show({ kind: 'loading' });
    setNotice(null);
    try {
      ack.current = await services.acknowledge(projectId);
      const kept = await services.jobs.load(projectId, design.sha256);
      if (!kept) return show({ kind: 'ready' });
      const attempt = await services.attempt(
        projectId,
        ack.current,
        kept.jobId,
      );
      if (attempt.intent) return show({ kind: 'sent', attempt });
      if (kept.prepared) return prepare(kept.allowSupports);
      show({ kind: 'ready' });
    } catch (error) {
      block(error);
    }
  }
  useEffect(() => {
    mounted.current = true;
    load();
    return () => {
      mounted.current = false;
    };
  }, [projectId, design.sha256, services]); // eslint-disable-line react-hooks/exhaustive-deps

  const print =
    phase.kind === 'prepared' ||
    phase.kind === 'sending' ||
    phase.kind === 'checking' ||
    phase.kind === 'unconfirmed'
      ? phase.print
      : null;
  const checks = print
    ? [
        {
          key: 'plate',
          text: `The ${bedLabel(
            print.selection.bedType,
          )} is on the printer, empty and clean`,
        },
        ...print.selection.materials.map(m => ({
          key: `material-${m.projectSlot}`,
          text: `${m.material} is loaded in ${trayLabel(m.physicalTray)}`,
        })),
      ]
    : [];
  const ready = checks.length > 0 && checks.every(c => checked[c.key]);

  let footer: React.ReactNode;
  if (phase.kind === 'ready' || phase.kind === 'preparing') {
    footer = (
      <Button
        label={phase.kind === 'preparing' ? 'Checking…' : 'Check printability'}
        disabled={phase.kind === 'preparing'}
        onPress={() => prepare(false)}
      />
    );
  } else if (phase.kind === 'needs-supports') {
    footer = (
      <Button label="Prepare with supports" onPress={() => prepare(true)} />
    );
  } else if (phase.kind === 'prepared' || phase.kind === 'sending') {
    footer = (
      <>
        <Text style={type.caption}>
          Your companion makes the final printer checks and starts the print.
        </Text>
        <Button
          label={phase.kind === 'sending' ? 'Sending…' : 'Send to printer'}
          disabled={!ready || phase.kind === 'sending'}
          accessibilityHint={
            ready ? undefined : 'Confirm each item in the checklist first'
          }
          onPress={() => send(phase.print)}
        />
      </>
    );
  } else if (phase.kind === 'unconfirmed') {
    footer = <Button label="Check again" onPress={() => verify(phase.print)} />;
  } else if (phase.kind === 'sent') {
    footer = (
      <Button
        label="Check status"
        variant="secondary"
        onPress={async () => {
          if (!ack.current || !phase.attempt.intent) return;
          try {
            const attempt = await services.attempt(
              projectId,
              ack.current,
              phase.attempt.intent.jobId,
            );
            if (attempt.intent) show({ kind: 'sent', attempt });
            setNotice(null);
          } catch (error) {
            setNotice({ tone: 'pending', text: failureOf(error).message });
          }
        }}
      />
    );
  }

  return (
    <Screen
      title="Print review"
      eyebrow="YOUR DESIGN / PRINT"
      subtitle="Check your design can print, then send it to your printer."
      onBack={onBack}
      footer={footer}
    >
      <View
        style={styles.design}
        accessible
        accessibilityLabel={`Design: ${designName}`}
      >
        <Text style={type.label}>DESIGN</Text>
        <Text style={type.heading}>{designName}</Text>
      </View>

      {phase.kind === 'loading' ? (
        <View style={styles.row}>
          <ActivityIndicator color={colors.muted} />
          <Text style={type.body}>Connecting to your companion…</Text>
        </View>
      ) : null}

      {phase.kind === 'blocked' ? (
        <BlockedNotice
          reason={phase.reason}
          message={phase.message}
          onRetry={load}
          onCompanion={onCompanion}
        />
      ) : null}

      {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}

      {phase.kind === 'ready' ? (
        <Card>
          <Text style={type.heading}>Check this design for printing</Text>
          <Text style={type.body}>
            Your companion checks the design can print, then slices it for your
            printer. This can take a minute.
          </Text>
          <Steps />
        </Card>
      ) : null}

      {phase.kind === 'preparing' ? (
        <Card>
          <View style={styles.row}>
            <ActivityIndicator color={colors.accent} />
            <Text accessibilityLiveRegion="polite" style={type.heading}>
              Checking and slicing
            </Text>
          </View>
          <Text style={type.body}>
            Your companion is checking the design and slicing it for your
            printer. This can take a minute.
          </Text>
          <Steps />
        </Card>
      ) : null}

      {phase.kind === 'not-printable' ? (
        <Verdict verdict="not-printable" report={phase.report}>
          {!phase.report ? (
            <Text style={type.body}>{phase.message}</Text>
          ) : null}
        </Verdict>
      ) : null}

      {phase.kind === 'needs-supports' ? (
        <Verdict verdict="printable-with-supports" report={phase.report}>
          <Text style={type.body}>
            Prepare it with supports to continue. They use a little more
            filament and time.
          </Text>
        </Verdict>
      ) : null}

      {print ? (
        <>
          <Verdict
            verdict={print.printability.verdict}
            report={print.printability}
          />
          <Card>
            <Text style={type.heading}>Print summary</Text>
            <View style={styles.stats}>
              {summaryRows(print.slice).map(row => (
                <View
                  key={row.label}
                  style={styles.stat}
                  accessible
                  accessibilityLabel={`${row.label}: ${row.value}`}
                >
                  <Text style={type.label}>{row.label.toUpperCase()}</Text>
                  <Text style={styles.statValue}>{row.value}</Text>
                </View>
              ))}
            </View>
            <Text style={type.label}>PRINTER</Text>
            <Text style={type.body}>{profileLine(print.profile)}</Text>
            <Text style={type.label}>FILAMENT</Text>
            {print.selection.materials.map(m => (
              <Text key={m.projectSlot} style={type.body}>
                {m.material} · {trayLabel(m.physicalTray)}
              </Text>
            ))}
            {print.slice.enableSupport ? (
              <Text style={type.caption}>Supports are included.</Text>
            ) : null}
          </Card>
          <Card>
            <Text style={type.heading}>Before you send</Text>
            <Text style={type.caption}>
              Check these at the printer. Your companion can’t see them.
            </Text>
            <View accessibilityRole="list" style={styles.checks}>
              {checks.map(check => (
                <Pressable
                  key={check.key}
                  accessibilityRole="checkbox"
                  accessibilityLabel={check.text}
                  accessibilityState={{
                    checked: !!checked[check.key],
                    disabled: phase.kind !== 'prepared',
                  }}
                  disabled={phase.kind !== 'prepared'}
                  onPress={() =>
                    setChecked(current => ({
                      ...current,
                      [check.key]: !current[check.key],
                    }))
                  }
                  style={({ pressed }) => [
                    styles.check,
                    pressed && styles.pressed,
                  ]}
                >
                  <View
                    style={[
                      styles.box,
                      checked[check.key] && styles.boxChecked,
                    ]}
                  >
                    {checked[check.key] ? (
                      <Text style={styles.tick}>✓</Text>
                    ) : null}
                  </View>
                  <Text style={[type.body, styles.flex]}>{check.text}</Text>
                </Pressable>
              ))}
            </View>
          </Card>
        </>
      ) : null}

      {phase.kind === 'checking' ? (
        <View style={styles.row}>
          <ActivityIndicator color={colors.muted} />
          <Text style={type.body}>Checking with your companion…</Text>
        </View>
      ) : null}

      {phase.kind === 'unconfirmed' ? (
        <Notice tone="pending" title="We couldn’t confirm it was sent">
          Your companion may already have it. Look at the printer, then check
          again here before sending anything else.
        </Notice>
      ) : null}

      {phase.kind === 'sent' ? (
        <Card>
          <Badge label="Sent" tone="pass" />
          <Text accessibilityLiveRegion="polite" style={type.heading}>
            Sent to your companion for printing
          </Text>
          <Text style={type.body}>{attemptText(phase.attempt)}</Text>
          <Text style={type.caption}>
            A finished print still needs checking against the real thing to
            confirm it fits.
          </Text>
        </Card>
      ) : null}
    </Screen>
  );
}

function Steps() {
  return (
    <View style={styles.steps}>
      {[
        'Check printability',
        'Slice for your printer',
        'Check the print file',
      ].map((step, index) => (
        <View
          key={step}
          style={styles.step}
          accessible
          accessibilityLabel={`Step ${index + 1} of 3, ${step}`}
        >
          <Text style={styles.stepNumber}>0{index + 1}</Text>
          <Text style={type.body}>{step}</Text>
        </View>
      ))}
    </View>
  );
}

function Verdict({
  verdict,
  report,
  children,
}: {
  verdict: keyof typeof VERDICTS;
  report?: PrintabilityReport;
  children?: React.ReactNode;
}) {
  const copy = VERDICTS[verdict];
  const reasons = report && verdict !== 'printable' ? reasonTexts(report) : [];
  const warnings = report ? warningTexts(report) : [];
  return (
    <Card>
      <View style={styles.badgeRow}>
        <Badge label={copy.label} tone={copy.tone} />
      </View>
      <Text accessibilityLiveRegion="polite" style={type.heading}>
        {copy.title}
      </Text>
      <Text style={type.body}>{copy.body}</Text>
      {reasons.map(reason => (
        <View key={reason} style={styles.bullet}>
          <View style={styles.dot} />
          <Text style={[type.body, styles.flex]}>{reason}</Text>
        </View>
      ))}
      {warnings.length ? <Text style={type.label}>WORTH KNOWING</Text> : null}
      {warnings.map(warning => (
        <View key={warning} style={styles.bullet}>
          <View style={[styles.dot, styles.dotMuted]} />
          <Text style={[type.body, styles.flex]}>{warning}</Text>
        </View>
      ))}
      {children}
      <Text style={type.caption}>
        This checks that the file can print. It doesn’t confirm the part will
        fit.
      </Text>
    </Card>
  );
}

function BlockedNotice({
  reason,
  message,
  onRetry,
  onCompanion,
}: {
  reason: Blocked;
  message: string;
  onRetry: () => void;
  onCompanion: () => void;
}) {
  if (reason === 'unavailable') {
    return <Notice title="Not available here">{message}</Notice>;
  }
  if (reason === 'changed') {
    return (
      <Notice tone="pending" title="This design changed">
        It was edited since you opened this screen. Go back and open the current
        version to print it.
      </Notice>
    );
  }
  const retry = (
    <Button label="Try again" variant="secondary" onPress={onRetry} />
  );
  const connect = (
    <Button
      label="Connect companion"
      variant={reason === 'connect' ? 'primary' : 'secondary'}
      onPress={onCompanion}
    />
  );
  if (reason === 'connect') {
    return (
      <Notice
        tone="pending"
        title="Connect your companion"
        action={
          <>
            {connect}
            {retry}
          </>
        }
      >
        Printing goes through your companion computer. Connect to it, then try
        again.
      </Notice>
    );
  }
  return (
    <Notice
      tone="fail"
      title={
        reason === 'unreachable'
          ? 'Your companion isn’t answering'
          : 'Couldn’t open print review'
      }
      action={
        <>
          {retry}
          {connect}
        </>
      }
    >
      {reason === 'unreachable'
        ? 'Check that your companion computer is on and connected, then try again.'
        : message}
    </Notice>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  design: { gap: space.xs },
  row: { flexDirection: 'row', gap: space.md, alignItems: 'center' },
  steps: { gap: space.sm, marginTop: space.xs },
  step: {
    flexDirection: 'row',
    gap: space.md,
    alignItems: 'center',
    minHeight: 44,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    paddingTop: space.sm,
  },
  stepNumber: {
    ...type.caption,
    color: colors.accent,
    fontVariant: ['tabular-nums'],
  },
  badgeRow: { flexDirection: 'row' },
  bullet: { flexDirection: 'row', gap: space.md, alignItems: 'flex-start' },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginTop: 9,
    backgroundColor: colors.accent,
  },
  dotMuted: { backgroundColor: colors.muted },
  stats: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.lg,
    marginVertical: space.sm,
  },
  stat: { flexBasis: '40%', flexGrow: 1, gap: space.xs },
  statValue: { ...type.stat, fontSize: 22, lineHeight: 28 },
  checks: { gap: space.sm },
  check: {
    flexDirection: 'row',
    gap: space.md,
    alignItems: 'center',
    minHeight: 48,
    paddingVertical: space.sm,
  },
  pressed: { opacity: 0.7 },
  box: {
    width: 26,
    height: 26,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxChecked: { borderColor: colors.accent, backgroundColor: colors.accent },
  tick: { color: colors.accentInk, fontSize: 16, fontWeight: '700' },
});
