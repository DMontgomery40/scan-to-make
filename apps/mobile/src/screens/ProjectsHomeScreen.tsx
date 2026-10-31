import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  AppState,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type ColorValue,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type {
  ListProjectsResult,
  SavedProject,
} from '@scan-to-make/contracts/saved-project';
import { companionNative, type CompanionNative } from '../companion/pairing';
import { Button, Field, READABLE_WIDTH, type Tone } from '../ui/components';
import { colors, radius, space, type } from '../ui/theme';
import {
  ACTIVE,
  mergeOverview,
  projectChip,
  projectSize,
  spokenSize,
  type Chip,
  type ProjectOverview,
} from './projectOverview';
import { useRequestGate } from './requestGate';
import type { ScanServices } from './scanServices';

/** How the Mac pill reads: connected, asleep, or needing to pair. */
export type MacState =
  | 'checking'
  | 'connected'
  | 'asleep'
  | 'pair-again'
  | 'unpaired';
const MAC: Record<
  MacState,
  { label: string; spoken: string; dot: ColorValue }
> = {
  checking: { label: 'Your Mac', spoken: 'Your Mac', dot: colors.line },
  connected: {
    label: 'Your Mac',
    spoken: 'Your Mac, connected',
    dot: colors.pass,
  },
  asleep: {
    label: 'Mac asleep',
    spoken: 'Mac asleep. Your phone can’t reach it right now',
    dot: colors.muted,
  },
  'pair-again': {
    label: 'Pair again',
    spoken: 'Pair your Mac again',
    dot: colors.pending,
  },
  unpaired: {
    label: 'Find your Mac',
    spoken: 'Find your Mac',
    dot: colors.muted,
  },
};
// Failures that mean the Mac is out of reach, not that the pairing is wrong.
const UNREACHABLE = new Set(['network', 'timeout', 'unavailable', 'cancelled']);

export const POLL_MS = 10000;
const MAX_POLLS = 180;
const GAP = 14;
// The Scan something bar: a 56 pt button inside 7 pt of padding.
const BAR_HEIGHT = 70;
const BAR_GAP = space.sm;
const SIDE = 20;

/**
 * Projects (home): one card per object with exactly one status, the Mac's
 * connection as a pill, and one way to start: Scan something.
 */
export function ProjectsHomeScreen({
  result,
  services,
  pairing = companionNative(),
  pairingKey = 0,
  paused = false,
  creating,
  createError,
  onCreate,
  onNaming,
  onOpen,
  onRetry,
  onPair,
  onSettings,
}: {
  result: ListProjectsResult | null;
  services: ScanServices;
  pairing?: CompanionNative;
  /** Changes when pairing may have changed, so the pill is read again. */
  pairingKey?: number;
  /** True while the pairing screen is open over home. */
  paused?: boolean;
  creating: boolean;
  createError: string | null;
  onCreate: (name: string) => Promise<boolean>;
  /** Called when the name sheet opens or closes, to clear an old error. */
  onNaming?: () => void;
  onOpen: (id: string) => void;
  onRetry: () => void;
  onPair: () => void;
  onSettings: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const gate = useRequestGate();
  const [mac, setMac] = useState<MacState>(pairing ? 'checking' : 'unpaired');
  const [overviews, setOverviews] = useState<
    Record<string, ProjectOverview | null>
  >({});
  const [naming, setNaming] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Bumped by pull to refresh and coming back to the app.
  const [round, setRound] = useState(0);
  // Bumped while a cleanup or print is under way, to look again.
  const [poll, setPoll] = useState(0);
  // Bumped each time every card has been read once.
  const [swept, setSwept] = useState(0);
  const live = useRef(true);
  // The latest statuses, read and merged outside React's state updates.
  const known = useRef<Record<string, ProjectOverview | null>>({});
  // The pairing check in flight. The pairing screen uses the same native
  // pairing, which turns overlapping calls away, so this one is cancelled
  // before that screen opens and when home goes away.
  const checking = useRef(false);
  // Bumped by stopCheck, so a check still waiting in the queue never starts.
  const checkRound = useRef(0);
  const stopCheck = useCallback(async () => {
    checkRound.current += 1;
    if (checking.current) await pairing?.cancel().catch(() => {});
  }, [pairing]);
  useEffect(
    () => () => {
      live.current = false;
      stopCheck();
    },
    [stopCheck],
  );

  const readMac = useCallback(async () => {
    if (!pairing) return setMac('unpaired');
    if (paused) return;
    // Taken before anything is awaited, so opening pairing stops this read
    // at every step.
    const asked = checkRound.current;
    try {
      const status = await pairing.status();
      if (!live.current || asked !== checkRound.current) return;
      if (status.state !== 'paired') {
        setMac(status.state === 'expired' ? 'pair-again' : 'unpaired');
        return;
      }
      setMac('checking');
      await gate(async () => {
        if (asked !== checkRound.current || !live.current) {
          throw Object.assign(Error('Stopped'), { code: 'stopped' });
        }
        checking.current = true;
        try {
          return await pairing.check();
        } finally {
          checking.current = false;
        }
      });
      if (live.current) setMac('connected');
    } catch (error) {
      const code = (error as { code?: string })?.code ?? '';
      if (code === 'stopped' || !live.current) return;
      setMac(UNREACHABLE.has(code) ? 'asleep' : 'pair-again');
    }
  }, [pairing, gate, paused]);
  useEffect(() => {
    if (paused) stopCheck();
  }, [paused, stopCheck]);
  useEffect(() => {
    readMac();
  }, [readMac, pairingKey]);
  // Opened only once home's own check has stopped.
  const openPairing = async () => {
    await stopCheck();
    onPair();
  };

  // Each card's status, one project at a time through the shared queue.
  const projects =
    result?.status === 'ok'
      ? result.entries.flatMap(e =>
          e.result.status === 'ok' ? [e.result.project] : [],
        )
      : [];
  const projectKey = projects.map(p => `${p.id}:${p.revision}`).join(',');
  // Nothing is read while the pairing screen is open over home.
  const pausedNow = useRef(paused);
  pausedNow.current = paused;
  useEffect(() => {
    const load = services.overview;
    if (!load || paused) return;
    let current = true;
    (async () => {
      for (const project of projects) {
        const overview = await gate(() =>
          pausedNow.current ? Promise.resolve(null) : load(project),
        ).catch(() => null);
        if (!current || !live.current || pausedNow.current) return;
        // What couldn't be read this time keeps its last known state, so a
        // cleanup or print in progress isn't dropped by one lost reply.
        const before = known.current[project.id] ?? null;
        const after = mergeOverview(before, overview);
        known.current = { ...known.current, [project.id]: after };
        announceDone(project, before, after);
        setOverviews(known.current);
      }
      setSwept(n => n + 1);
      setRefreshing(false);
    })();
    return () => {
      current = false;
    };
    // projectKey stands for the projects that were read.
  }, [projectKey, services, gate, pairingKey, round, poll, paused]); // eslint-disable-line react-hooks/exhaustive-deps

  // While anything is cleaning up or printing, look again a while after each
  // full pass, for up to half an hour per visit.
  const active = projects.some(p =>
    ACTIVE.includes(projectChip(overviews[p.id] ?? null).kind),
  );
  useEffect(() => {
    if (!active || paused || poll >= MAX_POLLS) return;
    const timer = setTimeout(() => setPoll(n => n + 1), POLL_MS);
    return () => clearTimeout(timer);
  }, [swept]); // eslint-disable-line react-hooks/exhaustive-deps

  const reload = useCallback(() => {
    onRetry();
    readMac();
    setPoll(0);
    setRound(n => n + 1);
  }, [onRetry, readMac]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', value => {
      if (value === 'active') reload();
    });
    return () => subscription.remove();
  }, [reload]);

  const columnWidth =
    (Math.min(width - insets.left - insets.right - SIDE * 2, READABLE_WIDTH) -
      GAP) /
    2;
  const empty = result?.status === 'ok' && result.entries.length === 0;

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          {
            paddingTop: insets.top + space.xs,
            // Clear of the Scan something bar, with room to spare.
            paddingBottom: insets.bottom + BAR_GAP + BAR_HEIGHT + space.xl,
            paddingLeft: insets.left + SIDE,
            paddingRight: insets.right + SIDE,
          },
        ]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              // Spins until every card has been read again.
              setRefreshing(!!services.overview);
              reload();
            }}
          />
        }
      >
        <View style={styles.column}>
          <View style={styles.topBar}>
            <MacPill state={mac} onPress={openPairing} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Settings"
              onPress={onSettings}
              hitSlop={8}
              style={({ pressed }) => [
                styles.circle,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.gear}>⚙︎</Text>
            </Pressable>
          </View>
          <Text accessibilityRole="header" style={styles.largeTitle}>
            Projects
          </Text>
          {!result ? (
            <Text style={[type.body, styles.gapTop]}>
              Opening your projects…
            </Text>
          ) : result.status === 'storage-error' ? (
            <View style={[styles.notice, styles.gapTop]}>
              <Text style={type.heading}>
                Your projects couldn’t be opened.
              </Text>
              <Text style={type.body}>Nothing on this phone was changed.</Text>
              <Button label="Try again" onPress={onRetry} />
            </View>
          ) : empty ? (
            <EmptyState windowHeight={height} />
          ) : (
            <View style={styles.grid}>
              {result.entries.map(({ id, result: entry }) =>
                entry.status === 'ok' ? (
                  <ProjectCard
                    key={id}
                    project={entry.project}
                    overview={overviews[id]}
                    loading={!!services.overview && !(id in overviews)}
                    width={columnWidth}
                    onPress={() => onOpen(id)}
                  />
                ) : (
                  <UnreadableCard
                    key={id}
                    id={id}
                    reason={entry.status}
                    width={columnWidth}
                  />
                ),
              )}
            </View>
          )}
        </View>
      </ScrollView>
      <View
        pointerEvents="box-none"
        style={[
          styles.barArea,
          {
            bottom: insets.bottom + BAR_GAP,
            paddingLeft: insets.left + space.md,
            paddingRight: insets.right + space.md,
          },
        ]}
      >
        <View style={styles.glassBar}>
          <Button
            label="Scan something"
            accessibilityHint="Name the object, then scan it with LiDAR."
            onPress={() => {
              onNaming?.();
              setNaming(true);
            }}
          />
        </View>
      </View>
      <NameSheet
        visible={naming}
        creating={creating}
        error={createError}
        onCancel={() => {
          onNaming?.();
          setNaming(false);
        }}
        onCreate={async name => {
          if (await onCreate(name)) setNaming(false);
        }}
      />
    </View>
  );
}

function MacPill({ state, onPress }: { state: MacState; onPress: () => void }) {
  const mac = MAC[state];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={mac.spoken}
      accessibilityHint="Opens pairing with your Mac."
      onPress={onPress}
      style={({ pressed }) => [styles.pill, pressed && styles.pressed]}
    >
      <View style={[styles.dot, { backgroundColor: mac.dot }]} />
      <Text style={styles.pillText}>{mac.label}</Text>
    </Pressable>
  );
}

const CHIP_COLORS: Record<Tone, { fg: ColorValue; bg: ColorValue }> = {
  neutral: { fg: colors.muted, bg: colors.stone },
  pass: { fg: colors.pass, bg: colors.passSoft },
  fail: { fg: colors.fail, bg: colors.failSoft },
  pending: { fg: colors.pending, bg: colors.pendingSoft },
  accent: { fg: colors.accent, bg: colors.accentSoft },
};

function StatusChip({ chip }: { chip: Chip | null }) {
  if (!chip) return <View style={[styles.chip, styles.chipLoading]} />;
  const tone = CHIP_COLORS[chip.tone];
  return (
    <View style={[styles.chip, { backgroundColor: tone.bg }]}>
      <View style={[styles.dot, { backgroundColor: tone.fg }]} />
      <Text style={[styles.chipText, { color: tone.fg }]}>{chip.label}</Text>
    </View>
  );
}

const nameOf = (project: SavedProject) =>
  project.brief.object.trim() || 'Untitled project';

/** Tells VoiceOver when a cleanup or print this screen was following ends. */
function announceDone(
  project: SavedProject,
  before: ProjectOverview | null,
  after: ProjectOverview | null,
) {
  if (!before || !after) return;
  const was = projectChip(before);
  const now = projectChip(after);
  if (ACTIVE.includes(was.kind) && !ACTIVE.includes(now.kind)) {
    AccessibilityInfo.announceForAccessibility(
      `${nameOf(project)}: ${now.label}`,
    );
  }
}

function ProjectCard({
  project,
  overview,
  loading,
  width,
  onPress,
}: {
  project: SavedProject;
  overview: ProjectOverview | null | undefined;
  loading: boolean;
  width: number;
  onPress: () => void;
}) {
  const name = nameOf(project);
  const chip = loading ? null : projectChip(overview ?? null);
  const size = projectSize(overview ?? null);
  const spoken = [name, chip?.label ?? 'Loading', spokenSize(overview ?? null)]
    .filter(Boolean)
    .join(', ');
  return (
    <Pressable
      accessible
      accessibilityRole="button"
      accessibilityLabel={spoken}
      accessibilityHint="Opens the project."
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        { width },
        pressed && styles.pressed,
      ]}
    >
      <Stage height={width * 0.95} imageUri={overview?.imageUri ?? null} />
      <View style={styles.meta}>
        <Text numberOfLines={2} style={styles.name}>
          {name}
        </Text>
        <StatusChip chip={chip} />
        {size ? <Text style={styles.size}>{size}</Text> : null}
      </View>
    </Pressable>
  );
}

function UnreadableCard({
  id,
  reason,
  width,
}: {
  id: string;
  reason: string;
  width: number;
}) {
  const label =
    reason === 'unsupported-version'
      ? 'Needs a newer app'
      : reason === 'corrupt'
      ? 'Can’t be read'
      : 'Unavailable';
  return (
    <View
      accessible
      accessibilityLabel={`A project this app can’t open, ${label}. It’s kept unchanged.`}
      style={[styles.card, { width }]}
    >
      <Stage height={width * 0.95} imageUri={null} />
      <View style={styles.meta}>
        <Text style={styles.name}>Can’t open this project</Text>
        <StatusChip chip={{ kind: 'waiting', label, tone: 'fail' }} />
        <Text style={styles.size}>Kept unchanged on this phone.</Text>
        <Text selectable numberOfLines={1} style={styles.size}>
          {id}
        </Text>
      </View>
    </View>
  );
}

/** The dark stage a model sits on; a dashed ring until there's a picture. */
function Stage({
  height,
  imageUri,
}: {
  height: number;
  imageUri: string | null;
}) {
  return (
    <View style={[styles.stage, { height }]}>
      {imageUri ? (
        <Image
          accessibilityIgnoresInvertColors
          source={{ uri: imageUri }}
          resizeMode="contain"
          style={StyleSheet.absoluteFill}
        />
      ) : (
        <View
          style={[styles.ring, { width: height * 0.62, height: height * 0.62 }]}
        />
      )}
    </View>
  );
}

const STEPS = [
  [
    'Walk around it with your iPhone',
    'About a minute. LiDAR measures it as you go.',
  ],
  [
    'Your Mac cleans it up',
    'Fills the gaps the camera missed. You can put the phone down.',
  ],
  ['Print it', 'One button. Your Mac checks the printer first.'],
];

function EmptyState({ windowHeight }: { windowHeight: number }) {
  // Short enough that all three steps clear the Scan something bar on a
  // phone; full size where there's room.
  const hero = Math.max(160, Math.min(300, windowHeight - 640));
  return (
    <View>
      <View style={[styles.stage, styles.hero, { height: hero }]}>
        <View
          style={[styles.ring, { width: hero * 0.67, height: hero * 0.67 }]}
        />
        <View style={styles.heroShape} />
      </View>
      <Text style={styles.emptyTitle}>Scan your first thing</Text>
      <Text style={styles.emptyBody}>
        Pick something small that fits in your hand. Put it on a table with some
        space around it.
      </Text>
      <View style={styles.steps}>
        {STEPS.map(([title, detail], index) => (
          <View
            key={title}
            accessible
            accessibilityLabel={`Step ${index + 1}. ${title}. ${detail}`}
            style={[styles.step, index > 0 && styles.stepLine]}
          >
            <View style={styles.stepNumber}>
              <Text style={styles.stepNumberText}>{index + 1}</Text>
            </View>
            <View style={styles.grow}>
              <Text style={styles.stepTitle}>{title}</Text>
              <Text style={type.caption}>{detail}</Text>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

/** Today's one question before a scan: what it is. */
function NameSheet({
  visible,
  creating,
  error,
  onCancel,
  onCreate,
}: {
  visible: boolean;
  creating: boolean;
  error: string | null;
  onCancel: () => void;
  onCreate: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const trimmed = name.trim();
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={creating ? undefined : onCancel}
    >
      {/* Scrolls and rises with the keyboard, so Continue and Cancel stay
          reachable in landscape and at large text sizes. */}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.sheet}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.sheetScroll}
        >
          <View style={styles.sheetColumn}>
            <Text accessibilityRole="header" style={type.heading}>
              Scan something
            </Text>
            <Field
              label="What are you scanning?"
              hint="For example, a phone case or a desk lamp."
              value={name}
              onChangeText={setName}
              editable={!creating}
              maxLength={200}
              returnKeyType="done"
            />
            {error ? (
              <Text accessibilityLiveRegion="polite" style={type.body}>
                {error}
              </Text>
            ) : null}
            <Button
              label={creating ? 'Saving…' : 'Continue'}
              disabled={creating || !trimmed}
              onPress={() => onCreate(trimmed)}
            />
            <Button
              label="Cancel"
              variant="secondary"
              disabled={creating}
              onPress={onCancel}
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  scroll: { flexGrow: 1, alignItems: 'center' },
  column: { width: '100%', maxWidth: READABLE_WIDTH },
  topBar: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 36,
    paddingLeft: space.md,
    paddingRight: 14,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  },
  pillText: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '600',
    color: colors.ink,
  },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
  circle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  },
  gear: { fontSize: 20, lineHeight: 24, color: colors.ink },
  pressed: { opacity: 0.7 },
  largeTitle: {
    ...type.title,
    fontWeight: '700',
    letterSpacing: -0.9,
    marginTop: space.xs,
  },
  gapTop: { marginTop: space.lg },
  notice: {
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: GAP,
    marginTop: space.lg,
  },
  card: {
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: colors.surface,
    shadowColor: '#141614',
    shadowOpacity: 0.07,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  stage: {
    backgroundColor: colors.viewport,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  ring: {
    borderRadius: 999,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: colors.viewportInk,
    opacity: 0.35,
  },
  meta: { padding: 13, paddingTop: 11, gap: 7 },
  name: {
    fontSize: 15,
    lineHeight: 19,
    fontWeight: '600',
    color: colors.ink,
    letterSpacing: -0.2,
  },
  chip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 26,
    maxWidth: '100%',
    paddingVertical: 5,
    paddingLeft: 9,
    paddingRight: 10,
    borderRadius: 13,
  },
  chipLoading: { width: 92, backgroundColor: colors.stone },
  chipText: { flexShrink: 1, fontSize: 12, lineHeight: 16, fontWeight: '600' },
  size: { fontSize: 12, lineHeight: 16, color: colors.muted },
  hero: {
    borderRadius: 28,
    marginTop: space.lg,
  },
  heroShape: {
    position: 'absolute',
    width: 92,
    height: 92,
    borderRadius: 26,
    borderWidth: 20,
    borderColor: colors.accent,
    transform: [{ rotate: '-9deg' }],
  },
  emptyTitle: {
    fontSize: 22,
    lineHeight: 27,
    fontWeight: '700',
    color: colors.ink,
    letterSpacing: -0.4,
    marginTop: space.xl,
  },
  emptyBody: { ...type.body, color: colors.muted, marginTop: space.sm },
  steps: { marginTop: space.lg },
  step: { flexDirection: 'row', gap: 14, paddingVertical: space.md },
  stepLine: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  stepNumber: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentSoft,
  },
  stepNumberText: { fontSize: 14, fontWeight: '700', color: colors.accent },
  stepTitle: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: '600',
    color: colors.ink,
  },
  grow: { flex: 1 },
  barArea: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  glassBar: {
    width: '100%',
    maxWidth: READABLE_WIDTH,
    padding: 7,
    borderRadius: 32,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    shadowColor: '#141614',
    shadowOpacity: 0.14,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
  },
  sheet: { flex: 1, backgroundColor: colors.background },
  sheetScroll: { padding: space.xl, alignItems: 'center' },
  sheetColumn: { width: '100%', maxWidth: READABLE_WIDTH, gap: space.lg },
});
