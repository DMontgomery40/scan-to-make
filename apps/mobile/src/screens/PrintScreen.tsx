import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ScanProcessingJob } from '@scan-to-make/contracts';
import {
  BACKEND_NAMES,
  isFinished,
  outcomeUnknown,
  type Confirmation,
  type ConfirmationAnswer,
  type Handoff,
  type PrinterBackend,
  type PrinterOption,
  type UncertainSend,
} from '../printing/printerHandoff';
import { Badge, Button, Card, Field, Notice, Screen, type Tone } from '../ui/components';
import { colors, radius, space, type } from '../ui/theme';
import { ConfirmationCard } from './ConfirmationCard';
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
// How often confirmation countdowns refresh.
const CLOCK_MS = 15000;
// The request travels in a request header, so it stays short.
const PROMPT_MAX = 2000;

type Phase =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'blocked'; connect: boolean; message: string }
  /** `options` is null when the companion picks its own printer software. */
  | { kind: 'ready'; options: PrinterOption[] | null };

/** What the job card says about a handoff at this moment. */
function describe(
  handoff: Handoff,
  asking: boolean,
): { badge: string; tone: Tone; title: string; detail?: string } {
  if (handoff.status === 'printed') {
    return {
      badge: 'Sent',
      tone: 'pass',
      title: 'Sent to your printer.',
      detail: 'Watch it start on the printer itself.',
    };
  }
  if (handoff.status === 'failed') {
    return handoff.failure === 'cancelled'
      ? { badge: 'Cancelled', tone: 'neutral', title: 'You cancelled this print.' }
      : { badge: 'Failed', tone: 'fail', title: 'This didn’t reach your printer.' };
  }
  if (handoff.printing) {
    return asking
      ? { badge: 'Needs you', tone: 'accent', title: 'Your printer is asking you something.' }
      : {
          badge: 'In progress',
          tone: 'pending',
          title: 'Preparing your print…',
          detail:
            'Your printer software slices and checks the model. It asks you here before anything starts.',
        };
  }
  if (handoff.prompt && handoff.status === 'ready') {
    return {
      badge: 'Waiting',
      tone: 'pending',
      title: 'Waiting for an agent on your computer.',
      detail:
        'Your request is saved with the model. An AI agent on your computer can make the change, then you print it here.',
    };
  }
  if (handoff.status === 'claimed') {
    return {
      badge: 'In progress',
      tone: 'pending',
      title: 'An agent on your computer is working on your request.',
    };
  }
  return {
    badge: 'Ready',
    tone: 'accent',
    title: handoff.status === 'ready' ? 'Ready to print.' : 'The change is ready to print.',
  };
}

export function PrintScreen({
  target,
  job,
  services,
  onBack,
  onCompanion,
}: {
  target: ScanTarget;
  /** The finished scan check whose cleaned-up model is sent. */
  job: ScanProcessingJob | null;
  services: ScanServices;
  onBack: () => void;
  onCompanion: () => void;
}) {
  const { projectId } = target;
  const captureId = target.capture.captureId;
  const printing = services.printing;
  const handoffs = services.handoffs;
  const choice = services.printerChoice;
  const gate = useRequestGate();
  const ack = useRef<ProjectAcknowledgment | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [backend, setBackend] = useState<PrinterBackend | null>(null);
  const [prompt, setPrompt] = useState('');
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [confirmations, setConfirmations] = useState<Confirmation[]>([]);
  const [working, setWorking] = useState<'sending' | 'printing' | 'cancelling' | null>(null);
  const [answering, setAnswering] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cancelNote, setCancelNote] = useState<string | null>(null);
  const [pollFailures, setPollFailures] = useState(0);
  const [pollError, setPollError] = useState<Failure | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Set by "Check again" and after a cancel so the next check runs at once.
  const checkNow = useRef(false);
  const [pollNonce, setPollNonce] = useState(0);
  // A send whose reply was lost: it may be on the companion, so no new send
  // until it is found there, ruled out, or the person sends anyway.
  const [uncertain, setUncertain] = useState<UncertainSend | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [reconcileError, setReconcileError] = useState<string | null>(null);

  const block = (error: unknown) => {
    const failure = failureOf(error);
    // A companion without printer handoff gets the same notice as no client.
    if (failure.code === 'not-available') {
      setPhase({ kind: 'unavailable' });
      return;
    }
    setPhase({
      kind: 'blocked',
      // A pairing without the printer scope needs a printer invitation.
      connect: needsConnection(failure) || failure.code === 'scope-denied',
      message: failure.message,
    });
  };
  const reconcile = useCallback(
    async (pending: UncertainSend, acked: ProjectAcknowledgment) => {
      if (!printing) return;
      setReconciling(true);
      setReconcileError(null);
      try {
        const found = await gate(() => printing.find(projectId, captureId, acked, pending));
        setUncertain(null);
        if (found) {
          setHandoff(found);
          await handoffs.save(projectId, captureId, { handoffId: found.id }).catch(() => {});
        } else {
          await handoffs.save(projectId, captureId, null).catch(() => {});
          setNotice('Your job didn’t reach your companion, so nothing was sent. You can send it again.');
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
      const remembered = await choice.load().catch(() => null);
      // The remembered choice, while the companion still offers it.
      setBackend(current => {
        const offered = (value: PrinterBackend | null) =>
          !!options?.some(option => option.backend === value);
        if (offered(current)) return current;
        if (offered(remembered)) return remembered;
        return options?.[0]?.backend ?? null;
      });
      // Reattach to the job sent from this scan before, so it isn't sent twice.
      const saved = await handoffs.load(projectId, captureId);
      const savedId = saved && 'handoffId' in saved ? saved.handoffId : null;
      const pending = saved && 'uncertain' in saved ? saved.uncertain : null;
      let current: Handoff | null = null;
      if (savedId) {
        try {
          current = await gate(() => printing.status(projectId, captureId, acked, savedId));
        } catch (error) {
          if (failureOf(error).status !== 404) throw error;
          // The companion no longer has it, so a new send is safe.
          await handoffs.save(projectId, captureId, null);
        }
      }
      setHandoff(current);
      setUncertain(pending);
      setConfirmations([]);
      setPollFailures(0);
      setPollError(null);
      setPhase({ kind: 'ready', options });
      if (pending) await reconcile(pending, acked);
    } catch (error) {
      block(error);
    }
  }, [printing, handoffs, choice, reconcile, services, projectId, captureId, gate]);
  useEffect(() => {
    load();
  }, [load]);

  // Follow a sent job until it is printed or failed, picking up the printer
  // server's questions while it runs. A failed check is retried with
  // backoff; repeated failures stop until the user checks again.
  useEffect(() => {
    if (!printing || !handoff || isFinished(handoff) || !ack.current) return;
    if (pollFailures >= MAX_POLL_FAILURES) return;
    const acked = ack.current;
    const delay = checkNow.current ? 0 : HANDOFF_POLL_MS * 2 ** pollFailures;
    checkNow.current = false;
    let live = true;
    const timer = setTimeout(() => {
      gate(async () => {
        const next = await printing.status(projectId, captureId, acked, handoff.id);
        const pending = next.printing ? await printing.confirmations() : [];
        return { next, pending };
      })
        .then(({ next, pending }) => {
          if (!live) return;
          setPollError(null);
          setPollFailures(0);
          setConfirmations(pending);
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
  }, [printing, handoff, pollFailures, pollNonce, projectId, captureId, gate]);

  // Keep confirmation countdowns current.
  const asking = confirmations.length > 0;
  useEffect(() => {
    if (!asking) return;
    setNow(Date.now());
    const clock = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(clock);
  }, [asking]);

  const checkAgain = () => {
    checkNow.current = true;
    setPollError(null);
    setPollFailures(0);
    setPollNonce(nonce => nonce + 1);
  };
  const startOver = () => {
    setHandoff(null);
    setConfirmations([]);
    setCancelNote(null);
    setNotice(null);
    setPollFailures(0);
    setPollError(null);
    handoffs.save(projectId, captureId, null).catch(() => {});
  };

  const options = phase.kind === 'ready' ? phase.options : [];
  const request = prompt.trim();
  const send = async () => {
    const acked = ack.current;
    if (!printing || !acked || !job || working || handoff || uncertain) return;
    if (options && !backend) return;
    setWorking('sending');
    setNotice(null);
    try {
      // The exact verified bytes of the cleaned-up model go to the companion.
      const model = await gate(() =>
        services.processing.downloadArtifact(projectId, captureId, acked, job, 'repaired.stl'),
      );
      // Written before the request: if the reply is lost or the app stops
      // mid-send, the companion is checked before anything is sent again.
      const pending: UncertainSend = {
        startedAtMs: Date.now(),
        prompt: request,
        backend: options ? backend : null,
        model: model.sha256,
      };
      try {
        await handoffs.save(projectId, captureId, { uncertain: pending });
      } catch {
        await handoffs.save(projectId, captureId, null).catch(() => {});
        setNotice(
          'This phone couldn’t save your send, so nothing was sent. Free up some storage on this phone, then try again.',
        );
        return;
      }
      let created: Handoff;
      try {
        created = await gate(() =>
          printing.create(projectId, captureId, acked, {
            prompt: request,
            backend: pending.backend,
            model,
          }),
        );
      } catch (error) {
        const failure = failureOf(error);
        if (outcomeUnknown(failure)) {
          setUncertain(pending);
          await reconcile(pending, acked);
        } else {
          // Refused outright, so nothing was created.
          await handoffs.save(projectId, captureId, null).catch(() => {});
          setNotice(failure.message);
        }
        return;
      }
      setHandoff(created);
      // The job is on the companion now, so a storage failure here is only a
      // warning: the session copy still reattaches if the screen is reopened.
      await handoffs.save(projectId, captureId, { handoffId: created.id }).catch(() =>
        setNotice(
          'This phone couldn’t save the job for after a restart. Keep the app open until it finishes so you don’t send it twice.',
        ),
      );
      if (options && backend) await choice.save(backend).catch(() => {});
      // With nothing to change, printing starts straight away.
      if (!request) {
        await gate(() => printing.print(created.id));
        setHandoff({ ...created, printing: true });
      }
    } catch (error) {
      setNotice(failureOf(error).message);
    } finally {
      setWorking(null);
    }
  };
  // The person's explicit choice after a send couldn't be confirmed.
  const sendAnyway = () => {
    setUncertain(null);
    setReconcileError(null);
    handoffs.save(projectId, captureId, null).catch(() => {});
  };
  const startPrint = async () => {
    if (!printing || !handoff || working) return;
    setWorking('printing');
    setNotice(null);
    try {
      await gate(() => printing.print(handoff.id));
      setHandoff({ ...handoff, printing: true });
    } catch (error) {
      setNotice(failureOf(error).message);
    } finally {
      setWorking(null);
    }
  };
  const answer = async (confirmation: Confirmation, reply: ConfirmationAnswer) => {
    if (!printing || answering) return;
    setAnswering(confirmation.id);
    setNotice(null);
    try {
      await gate(() => printing.answer(confirmation.id, reply));
      setConfirmations(current => current.filter(c => c.id !== confirmation.id));
    } catch (error) {
      const failure = failureOf(error);
      if (failure.status === 404) {
        setConfirmations(current => current.filter(c => c.id !== confirmation.id));
      }
      setNotice(failure.message);
    } finally {
      setAnswering(null);
    }
  };
  const cancel = async () => {
    if (!printing || !handoff || working) return;
    setWorking('cancelling');
    setNotice(null);
    const pending = confirmations;
    try {
      // Answering "cancel" first means none of these can start a print.
      const unanswered: Confirmation[] = [];
      for (const confirmation of pending) {
        await gate(() => printing.answer(confirmation.id, { action: 'cancel' })).catch(() =>
          unanswered.push(confirmation),
        );
      }
      // Questions that couldn't be cancelled stay on screen to deny by hand.
      setConfirmations(unanswered);
      const stopped = await gate(() => printing.cancel(handoff.id));
      setCancelNote(
        stopped
          ? null
          : unanswered.length
          ? 'Some of your printer’s questions couldn’t be cancelled. Deny any still showing here, or check your computer.'
          : pending.length
          ? 'Cancelled. Nothing was sent to your printer.'
          : 'Your companion can’t stop this job from the phone. It still asks here before anything prints, so you can deny it then.',
      );
      checkAgain();
    } catch (error) {
      setNotice(failureOf(error).message);
    } finally {
      setWorking(null);
    }
  };

  const view = handoff ? describe(handoff, asking) : null;
  const canPrint =
    !!handoff &&
    !handoff.printing &&
    !isFinished(handoff) &&
    (handoff.status === 'designed' ||
      handoff.status === 'sliced' ||
      (handoff.status === 'ready' && !handoff.prompt));
  const waitingForAgent = !!handoff && !handoff.printing && handoff.status === 'ready' && !!handoff.prompt;
  const canSend =
    phase.kind === 'ready' &&
    !handoff &&
    !uncertain &&
    !!job &&
    (options === null || (options.length > 0 && !!backend));

  let footer: React.ReactNode;
  if (canSend) {
    footer = (
      <Button
        label={working === 'sending' ? 'Sending…' : request ? 'Send with request' : 'Send to printer'}
        disabled={!!working}
        onPress={send}
      />
    );
  } else if (canPrint) {
    footer = (
      <Button label={working === 'printing' ? 'Starting…' : 'Print it'} disabled={!!working} onPress={startPrint} />
    );
  } else if (waitingForAgent) {
    footer = (
      <Button
        label={working === 'printing' ? 'Starting…' : 'Print without changes'}
        variant="secondary"
        disabled={!!working}
        onPress={startPrint}
      />
    );
  } else if (handoff?.printing && !isFinished(handoff)) {
    footer = (
      <Button
        label={working === 'cancelling' ? 'Cancelling…' : 'Cancel print'}
        variant="secondary"
        disabled={!!working}
        onPress={cancel}
      />
    );
  }

  return (
    <Screen
      title="Send to printer"
      eyebrow="YOUR SCAN / PRINT"
      subtitle="Your computer slices and prints the cleaned-up scan with the printer software you set up there."
      onBack={working === 'sending' ? undefined : onBack}
      footer={footer}
    >
      {phase.kind === 'loading' ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.muted} />
          <Text style={type.body}>Checking your printer setup…</Text>
        </View>
      ) : null}
      {phase.kind === 'unavailable' ? (
        <Notice title="Not available yet">
          Sending to a printer needs an update to your companion. Until then, share the STL file
          from Scan results and print it yourself.
        </Notice>
      ) : null}
      {phase.kind === 'blocked' ? (
        <Notice
          tone={phase.connect ? 'pending' : 'fail'}
          title={phase.connect ? 'Connect your companion' : 'Couldn’t check your printer setup'}
          action={
            <>
              {phase.connect ? <Button label="Connect companion" onPress={onCompanion} /> : null}
              <Button label="Try again" variant="secondary" onPress={load} />
            </>
          }
        >
          {phase.message}
        </Notice>
      ) : null}
      {phase.kind === 'ready' && options !== null && !options.length && !handoff ? (
        <Notice tone="pending" title="No printer set up">
          Your companion has no printer software configured. Set up bambu-printer-mcp or
          mcp-3D-printer-server on your computer, then try again.
        </Notice>
      ) : null}
      {phase.kind === 'ready' && !job && !handoff ? (
        <Notice tone="pending" title="Check your scan first">
          Sending needs a finished scan check. Go back to Scan results and check your scan.
        </Notice>
      ) : null}

      {uncertain ? (
        <Notice
          tone="pending"
          title={reconciling ? 'Checking your companion' : 'Couldn’t confirm your send'}
          action={
            reconciling ? undefined : (
              <>
                <Button
                  label="Check again"
                  onPress={() => ack.current && reconcile(uncertain, ack.current)}
                />
                <Button label="Send anyway" variant="secondary" onPress={sendAnyway} />
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
      {phase.kind === 'ready' && !handoff && !uncertain && job && (options === null || options.length > 0) ? (
        <>
          <Card>
            <Text style={type.heading}>The cleaned-up model</Text>
            <Text style={type.caption}>From this scan’s finished check.</Text>
          </Card>
          <Field
            label="Anything to change? (optional)"
            hint="Leave it empty to print the model as it is. A request waits for an AI agent on your computer to make the change first."
            value={prompt}
            onChangeText={setPrompt}
            multiline
            maxLength={PROMPT_MAX}
          />
          <View style={styles.section}>
            <Text style={type.label}>PRINTER SOFTWARE</Text>
            {options === null ? (
              <Card>
                <Text style={type.heading}>Your companion’s printer software</Text>
                <Text style={type.caption}>Your companion chooses which printer software to use.</Text>
              </Card>
            ) : options.length === 1 ? (
              <Card>
                <Text style={type.heading}>{BACKEND_NAMES[options[0]!.backend].title}</Text>
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
                        <Text style={type.heading}>{BACKEND_NAMES[option.backend].title}</Text>
                        <Text style={type.caption}>{optionDetail(option)}</Text>
                      </View>
                    </Pressable>
                  );
                })}
                <Text style={type.caption}>This phone remembers your choice for next time.</Text>
              </View>
            )}
          </View>
        </>
      ) : null}

      {handoff && view ? (
        <Card>
          <View style={styles.head}>
            <Text style={[type.heading, styles.grow]}>{BACKEND_NAMES[handoff.backend].title}</Text>
            <Badge label={view.badge} tone={view.tone} />
          </View>
          <View style={styles.status} accessibilityLiveRegion="polite">
            {handoff.printing && !asking && !isFinished(handoff) ? (
              <ActivityIndicator color={colors.muted} />
            ) : null}
            <Text style={[type.body, styles.grow]}>{view.title}</Text>
          </View>
          {view.detail ? <Text style={type.caption}>{view.detail}</Text> : null}
          {handoff.prompt ? <Text style={type.caption}>Your request: “{handoff.prompt}”</Text> : null}
          {handoff.failure && handoff.failure !== 'cancelled' ? (
            <Text style={type.caption}>{handoff.failure}</Text>
          ) : null}
          {cancelNote ? <Text style={type.caption}>{cancelNote}</Text> : null}
          {pollError && pollFailures < MAX_POLL_FAILURES ? (
            <Text style={type.caption}>Couldn’t reach your companion. Trying again…</Text>
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
                  <Button label="Check again" variant="secondary" onPress={checkAgain} />
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

      {handoff?.printing && !isFinished(handoff)
        ? confirmations.map(confirmation => (
            <ConfirmationCard
              key={confirmation.id}
              confirmation={confirmation}
              now={now}
              answering={answering === confirmation.id || working === 'cancelling'}
              onAnswer={reply => answer(confirmation, reply)}
            />
          ))
        : null}
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
  status: { flexDirection: 'row', alignItems: 'center', gap: space.md },
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
  dot: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: colors.muted },
  dotChosen: { borderColor: colors.accent, borderWidth: 6 },
});
