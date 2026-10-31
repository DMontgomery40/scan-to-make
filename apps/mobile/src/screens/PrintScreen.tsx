import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  BACKEND_NAMES,
  STATUS_TEXT,
  isFinished,
  outcomeUnknown,
  type Handoff,
  type UncertainSend,
  type PrinterBackend,
  type PrinterOption,
} from '../printing/printerHandoff';
import { Badge, Button, Card, Field, Notice, Screen } from '../ui/components';
import { colors, radius, space, type } from '../ui/theme';
import { useRequestGate } from './requestGate';
import {
  failureOf,
  needsConnection,
  type Failure,
  type ProjectAcknowledgment,
  type ScanServices,
  type ScanTarget,
} from './scanServices';

// How often a sent job's progress is checked while this screen is open.
export const HANDOFF_POLL_MS = 3000;
// Failed checks back off (3 s, 6 s, 12 s); after this many in a row the
// screen stops and offers to check again.
export const MAX_POLL_FAILURES = 3;

type Phase =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'blocked'; connect: boolean; message: string }
  | { kind: 'ready'; options: PrinterOption[] };

export function PrintScreen({
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
  const printing = services.printing;
  const handoffs = services.handoffs;
  const gate = useRequestGate();
  const ack = useRef<ProjectAcknowledgment | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [backend, setBackend] = useState<PrinterBackend | null>(null);
  const [prompt, setPrompt] = useState('Print a copy.');
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pollFailures, setPollFailures] = useState(0);
  const [pollError, setPollError] = useState<Failure | null>(null);
  // A send whose reply was lost: it may be on the companion, so no new send
  // until it is found there, ruled out, or the person sends anyway.
  const [uncertain, setUncertain] = useState<UncertainSend | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [reconcileError, setReconcileError] = useState<string | null>(null);
  // Set by "Check again" so the next status check runs without waiting.
  const checkNow = useRef(false);

  const block = (error: unknown) => {
    const failure = failureOf(error);
    setPhase({
      kind: 'blocked',
      connect: needsConnection(failure),
      message: failure.message,
    });
  };
  const reconcile = useCallback(
    async (pending: UncertainSend, acked: ProjectAcknowledgment) => {
      if (!printing) return;
      setReconciling(true);
      setReconcileError(null);
      try {
        const found = await gate(() =>
          printing.find(projectId, captureId, acked, pending),
        );
        setUncertain(null);
        if (found) {
          setHandoff(found);
          await handoffs
            .save(projectId, captureId, { handoffId: found.id })
            .catch(() => {});
        } else {
          await handoffs.save(projectId, captureId, null).catch(() => {});
          setNotice(
            'Your job didn’t reach your companion, so nothing was sent. You can send it again.',
          );
        }
      } catch (error) {
        setReconcileError(failureOf(error).message);
      } finally {
        setReconciling(false);
      }
    },
    [printing, handoffs, projectId, captureId, gate],
  );
  const load = useCallback(async () => {
    if (!printing) {
      setPhase({ kind: 'unavailable' });
      return;
    }
    setPhase({ kind: 'loading' });
    try {
      const acked = await gate(() => services.acknowledge(projectId));
      ack.current = acked;
      const options = await gate(() => printing.backends(acked));
      // Keep the person's choice only while the companion still offers it.
      setBackend(current =>
        options.some(option => option.backend === current)
          ? current
          : options[0]?.backend ?? null,
      );
      // Reattach to the job sent from this scan before, so it isn't sent twice.
      const saved = await handoffs.load(projectId, captureId);
      const savedId = saved && 'handoffId' in saved ? saved.handoffId : null;
      const pending = saved && 'uncertain' in saved ? saved.uncertain : null;
      let current: Handoff | null = null;
      if (savedId) {
        try {
          current = await gate(() =>
            printing.status(projectId, captureId, acked, savedId),
          );
        } catch (error) {
          if (failureOf(error).status !== 404) throw error;
          // The companion no longer has it, so a new send is safe.
          await handoffs.save(projectId, captureId, null);
        }
      }
      setHandoff(current);
      setUncertain(pending);
      setPollFailures(0);
      setPollError(null);
      setPhase({ kind: 'ready', options });
      if (pending) await reconcile(pending, acked);
    } catch (error) {
      block(error);
    }
  }, [printing, handoffs, reconcile, services, projectId, captureId, gate]);
  useEffect(() => {
    load();
  }, [load]);

  // Follow a sent job until it is printed or failed. A failed check is
  // retried with backoff; repeated failures stop until the user checks again.
  useEffect(() => {
    if (!printing || !handoff || isFinished(handoff) || !ack.current) return;
    if (pollFailures >= MAX_POLL_FAILURES) return;
    const acked = ack.current;
    const delay = checkNow.current ? 0 : HANDOFF_POLL_MS * 2 ** pollFailures;
    checkNow.current = false;
    let live = true;
    const timer = setTimeout(() => {
      gate(() => printing.status(projectId, captureId, acked, handoff.id))
        .then(next => {
          if (!live) return;
          setPollError(null);
          setPollFailures(0);
          setHandoff(next);
        })
        .catch(error => {
          if (!live) return;
          setPollError(failureOf(error));
          setPollFailures(count => count + 1);
        });
    }, delay);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [printing, handoff, pollFailures, projectId, captureId, gate]);
  const checkAgain = () => {
    checkNow.current = true;
    setPollError(null);
    setPollFailures(0);
  };
  const startOver = () => {
    setHandoff(null);
    setPollFailures(0);
    setPollError(null);
    handoffs.save(projectId, captureId, null).catch(() => {});
  };

  const send = async () => {
    const acked = ack.current;
    const text = prompt.trim();
    if (!printing || !acked || !backend || !text || sending || handoff || uncertain)
      return;
    setSending(true);
    setNotice(null);
    // Written before the request: if the app stops mid-send, reopening
    // reconciles with the companion instead of offering a duplicate.
    const pending: UncertainSend = { startedAtMs: Date.now(), prompt: text, backend };
    try {
      await handoffs.save(projectId, captureId, { uncertain: pending });
    } catch {
      // Without that record a lost reply could lead to a second job, so
      // nothing is sent.
      await handoffs.save(projectId, captureId, null).catch(() => {});
      setNotice(
        'This phone couldn’t save your send, so nothing was sent. Free up some storage on this phone, then try again.',
      );
      setSending(false);
      return;
    }
    try {
      const created = await gate(() =>
        printing.create(projectId, captureId, acked, {
          prompt: text,
          backend,
        }),
      );
      setHandoff(created);
      // The job is on the companion now, so a storage failure here is only a
      // warning: the session copy still reattaches if the screen is reopened.
      await handoffs.save(projectId, captureId, { handoffId: created.id }).catch(() =>
        setNotice(
          'This phone couldn’t save the job for after a restart. Keep the app open until it finishes so you don’t send it twice.',
        ),
      );
    } catch (error) {
      const failure = failureOf(error);
      if (outcomeUnknown(failure)) {
        // The companion may have the job; the record above already says so.
        setUncertain(pending);
        await reconcile(pending, acked);
      } else {
        // Refused outright, so nothing was created.
        await handoffs.save(projectId, captureId, null).catch(() => {});
        setNotice(failure.message);
      }
    } finally {
      setSending(false);
    }
  };
  // The person's explicit choice after a send couldn't be confirmed.
  const sendAnyway = () => {
    setUncertain(null);
    setReconcileError(null);
    handoffs.save(projectId, captureId, null).catch(() => {});
  };

  const options = phase.kind === 'ready' ? phase.options : [];
  const canSend =
    phase.kind === 'ready' &&
    !!backend &&
    !!prompt.trim() &&
    !handoff &&
    !uncertain;
  return (
    <Screen
      title="Send to printer"
      eyebrow="YOUR SCAN / PRINT"
      subtitle="Your computer slices and prints the cleaned-up scan with the printer tools you set up there."
      onBack={sending ? undefined : onBack}
      footer={
        canSend ? (
          <Button
            label={sending ? 'Sending…' : 'Send to printer'}
            disabled={sending}
            onPress={send}
          />
        ) : undefined
      }
    >
      {phase.kind === 'loading' ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.muted} />
          <Text style={type.body}>Checking your printer setup…</Text>
        </View>
      ) : null}
      {phase.kind === 'unavailable' ? (
        <Notice title="Not available yet">
          Sending to a printer needs an update to your companion. Until then,
          share the STL file from Scan results and print it yourself.
        </Notice>
      ) : null}
      {phase.kind === 'blocked' ? (
        <Notice
          tone={phase.connect ? 'pending' : 'fail'}
          title={
            phase.connect
              ? 'Connect your companion'
              : 'Couldn’t check your printer setup'
          }
          action={
            <>
              {phase.connect ? (
                <Button label="Connect companion" onPress={onCompanion} />
              ) : null}
              <Button label="Try again" variant="secondary" onPress={load} />
            </>
          }
        >
          {phase.message}
        </Notice>
      ) : null}
      {phase.kind === 'ready' && !options.length ? (
        <Notice tone="pending" title="No printer set up">
          Your companion has no printer tools configured. Set up
          bambu-printer-mcp or mcp-3D-printer-server on your computer, then try
          again.
        </Notice>
      ) : null}

      {uncertain ? (
        <Notice
          tone="pending"
          title={
            reconciling ? 'Checking your companion' : 'Couldn’t confirm your send'
          }
          action={
            reconciling ? undefined : (
              <>
                <Button
                  label="Check again"
                  onPress={() => ack.current && reconcile(uncertain, ack.current)}
                />
                <Button
                  label="Send anyway"
                  variant="secondary"
                  onPress={sendAnyway}
                />
              </>
            )
          }
        >
          {reconciling
            ? 'The reply to your send was lost. Looking for the job on your companion before anything is sent again.'
            : `${
                reconcileError ? `${reconcileError} ` : ''
              }The job may already be on your companion. Check again once it’s reachable. Send anyway only if you’re sure it didn’t arrive, or you may end up with two jobs.`}
        </Notice>
      ) : null}
      {options.length > 0 && !handoff && !uncertain ? (
        <>
          <Field
            label="What should your printer make?"
            hint="Ask for a copy, or describe a change, like a stand that fits it."
            value={prompt}
            onChangeText={setPrompt}
            multiline
            maxLength={8000}
          />
          <View style={styles.section}>
            <Text style={type.label}>PRINTER</Text>
            {options.length === 1 ? (
              <Card>
                <Text style={type.heading}>
                  {BACKEND_NAMES[options[0]!.backend].title}
                </Text>
                <Text style={type.caption}>{optionDetail(options[0]!)}</Text>
              </Card>
            ) : (
              <View accessibilityRole="radiogroup" style={styles.section}>
                {options.map(option => {
                  const chosen = option.backend === backend;
                  return (
                    <Pressable
                      key={option.backend}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: chosen }}
                      accessibilityLabel={BACKEND_NAMES[option.backend].title}
                      onPress={() => setBackend(option.backend)}
                      style={[styles.option, chosen && styles.optionChosen]}
                    >
                      <View style={[styles.dot, chosen && styles.dotChosen]} />
                      <View style={styles.grow}>
                        <Text style={type.heading}>
                          {BACKEND_NAMES[option.backend].title}
                        </Text>
                        <Text style={type.caption}>{optionDetail(option)}</Text>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            )}
          </View>
        </>
      ) : null}

      {handoff ? (
        <Card>
          <View style={styles.head}>
            <Text style={[type.heading, styles.grow]}>
              {BACKEND_NAMES[handoff.backend].title}
            </Text>
            <Badge
              label={
                handoff.status === 'printed'
                  ? 'Sent'
                  : handoff.status === 'failed'
                  ? 'Failed'
                  : 'In progress'
              }
              tone={
                handoff.status === 'printed'
                  ? 'pass'
                  : handoff.status === 'failed'
                  ? 'fail'
                  : 'pending'
              }
            />
          </View>
          <Text accessibilityLiveRegion="polite" style={type.body}>
            {STATUS_TEXT[handoff.status]}
          </Text>
          {handoff.failure ? (
            <Text style={type.caption}>{handoff.failure}</Text>
          ) : null}
          {pollError && pollFailures < MAX_POLL_FAILURES ? (
            <Text style={type.caption}>
              Couldn’t reach your companion. Trying again…
            </Text>
          ) : null}
          {pollError && pollFailures >= MAX_POLL_FAILURES ? (
            <Notice
              tone="pending"
              title="Lost touch with your companion"
              action={
                <>
                  {needsConnection(pollError) ? (
                    <Button label="Connect companion" onPress={onCompanion} />
                  ) : null}
                  <Button
                    label="Check again"
                    variant="secondary"
                    onPress={checkAgain}
                  />
                </>
              }
            >
              {`${pollError.message} The job is still on your companion.`}
            </Notice>
          ) : null}
          {handoff.status === 'failed' ? (
            <Button label="Start over" variant="secondary" onPress={startOver} />
          ) : handoff.status === 'printed' ? (
            <Button label="Send again" variant="secondary" onPress={startOver} />
          ) : null}
        </Card>
      ) : null}
      {notice ? <Notice tone="pending">{notice}</Notice> : null}
    </Screen>
  );
}

function optionDetail(option: PrinterOption) {
  const printer = option.selection?.printerType ?? option.selection?.model;
  const detail = BACKEND_NAMES[option.backend].detail;
  return printer ? `${detail} · set up for ${printer}` : detail;
}

const styles = StyleSheet.create({
  loading: { flexDirection: 'row', gap: space.md, alignItems: 'center' },
  section: { gap: space.md },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  grow: { flex: 1 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  optionChosen: { borderColor: colors.accent, borderWidth: 2 },
  dot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: colors.muted,
  },
  dotChosen: { borderColor: colors.accent, borderWidth: 6 },
});
