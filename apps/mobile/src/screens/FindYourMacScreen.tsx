import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  companionNative,
  EXPIRED,
  pairingError,
  UNREACHABLE,
  type CompanionNative,
  type PairingStatus,
} from '../companion/pairing';
import { parsePairingQR } from '../companion/pairingLink';
import { QRViewfinder, type ViewfinderState } from '../companion/QRViewfinder';
import { Button, READABLE_WIDTH } from '../ui/components';
import { colors, radius, space, type } from '../ui/theme';

/** What to open once this phone is paired; 'back' returns to where it began. */
export type AfterPairing = 'scan' | 'projects' | 'back';

type Phase =
  | { kind: 'scanning' }
  // The one sentence shown before iOS asks about the local network.
  | { kind: 'asking'; code: string }
  | { kind: 'pairing' }
  | { kind: 'failed'; message: string; retry?: string }
  | { kind: 'connected' };

const DEVICE_NAME = 'My phone';
const OUT_OF_REACH = new Set(['network', 'timeout']);
// A check that ends like this says nothing about the pairing itself.
const NOT_ANSWERING = new Set([
  ...OUT_OF_REACH,
  'unavailable',
  'busy',
  'cancelled',
]);

/**
 * Find your Mac (P7): point the camera at the code in Scan to Make on your
 * Mac, and it pairs. An already-paired phone sees its Mac instead (P8).
 */
export function FindYourMacScreen({
  onBack,
  onDone,
  canScan = false,
  resume = false,
  paused = false,
  native = companionNative(),
  link,
  onLinkUsed,
}: {
  /** Absent when this is the first screen, before any Mac is paired. */
  onBack?: () => void;
  onDone: (next: AfterPairing) => void;
  /** True on devices that can scan with LiDAR. */
  canScan?: boolean;
  /** True when pairing began in the middle of something: Connected goes back. */
  resume?: boolean;
  /** True while another screen covers this one: the camera stays off. */
  paused?: boolean;
  native?: CompanionNative;
  /** A pairing link the app was opened with, e.g. from the Camera app. */
  link?: string | null;
  onLinkUsed?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [status, setStatus] = useState<PairingStatus | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'scanning' });
  const [camera, setCamera] = useState<ViewfinderState | null>(null);
  // Replacing the paired Mac with another one, after asking.
  const [replacing, setReplacing] = useState(false);
  const [reachable, setReachable] = useState<boolean | null>(null);
  // Why the paired Mac turned this phone away, when it answered at all.
  const [refused, setRefused] = useState<string | null>(null);
  // A pairing link waiting to be used.
  const [pending, setPending] = useState<string | null>(null);
  // iOS asks about the local network once; the sentence before it, once too.
  const asked = useRef(false);
  // Held synchronously: a code is used once, however often the camera sees it.
  const working = useRef(false);

  const readStatus = async () => {
    try {
      const value = await native!.status();
      setStatus(value);
      setReadFailed(false);
      return value;
    } catch {
      setReadFailed(true);
      return null;
    }
  };
  useEffect(() => {
    if (!native) return;
    readStatus();
    return () => {
      native.cancel().catch(() => {});
    };
  }, [native]); // eslint-disable-line react-hooks/exhaustive-deps

  const paired = status?.state === 'paired' && !replacing;
  // An already-paired phone checks its Mac once, to say whether it answers.
  useEffect(() => {
    if (!native || !paired || phase.kind === 'connected') return;
    let live = true;
    native
      .check()
      .then(() => {
        if (!live) return;
        setReachable(true);
        setRefused(null);
      })
      .catch(error => {
        if (!live) return;
        setReachable(false);
        const code = (error as { code?: string })?.code ?? '';
        setRefused(
          NOT_ANSWERING.has(code) ? null : pairingError(error) ?? null,
        );
      });
    return () => {
      live = false;
    };
  }, [native, paired]); // eslint-disable-line react-hooks/exhaustive-deps

  const pair = async (value: string) => {
    if (!native) return;
    setPhase({ kind: 'pairing' });
    try {
      const parsed = parsePairingQR(value);
      const result = await native.pair(
        parsed.baseUrl,
        parsed.code,
        DEVICE_NAME,
        parsed.certificateSha256 ?? null,
      );
      setStatus(result);
      setReplacing(false);
      setReachable(true);
      setPhase({ kind: 'connected' });
    } catch (error) {
      const code = (error as { code?: string })?.code ?? '';
      setPhase({
        kind: 'failed',
        message:
          code === 'expired-invitation'
            ? EXPIRED
            : OUT_OF_REACH.has(code)
            ? `${UNREACHABLE} If your iPhone just asked about your Wi-Fi, tap Allow, then try again.`
            : pairingError(error) ??
              'Pairing didn’t finish. Show a new code on your Mac and scan it.',
        // The code may never have reached your Mac, so it can be tried again
        // while it's still valid.
        ...(OUT_OF_REACH.has(code) ? { retry: value } : {}),
      });
    } finally {
      working.current = false;
    }
  };
  // A code from the camera or a link: parsed first, then the sentence about
  // the local network the first time, then pairing.
  const use = (value: string) => {
    if (working.current || !native) return;
    working.current = true;
    try {
      const parsed = parsePairingQR(value);
      if (parsed.certificateSha256 && !asked.current) {
        setPhase({ kind: 'asking', code: value });
        working.current = false;
        return;
      }
    } catch (error) {
      working.current = false;
      const code = (error as { code?: string })?.code;
      setPhase({
        kind: 'failed',
        message: code === 'expired-invitation' ? EXPIRED : pairingError(error)!,
      });
      return;
    }
    pair(value);
  };

  // A link is taken once. It waits for the stored pairing to be read, and
  // never replaces a paired Mac without asking.
  useEffect(() => {
    if (!link) return;
    onLinkUsed?.();
    setPending(link);
  }, [link]); // eslint-disable-line react-hooks/exhaustive-deps
  // A link that comes in while a code is in use goes next (hence phase).
  useEffect(() => {
    if (!pending || !status || paired || working.current) return;
    setPending(null);
    use(pending);
  }, [pending, status, paired, phase.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!native) {
    return (
      <Shell insets={insets} onBack={onBack}>
        <Text accessibilityRole="header" style={styles.title}>
          Find your Mac
        </Text>
        <Text style={styles.body}>
          Pairing with your Mac works in the iPhone and iPad app.
        </Text>
      </Shell>
    );
  }

  // A link that came in during the exchange, or while Connected shows, asks
  // first (below): Done would otherwise drop it unseen.
  if (phase.kind === 'connected' && !pending) {
    return (
      <View
        style={[
          styles.screen,
          styles.connected,
          { paddingTop: insets.top, paddingBottom: insets.bottom + space.lg },
        ]}
      >
        <View style={styles.connectedMiddle}>
          <View style={styles.halo}>
            <View
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={styles.check}
            >
              <Text style={styles.checkMark}>✓</Text>
            </View>
          </View>
          <Text
            accessibilityRole="header"
            accessibilityLiveRegion="polite"
            style={styles.connectedTitle}
          >
            Connected to your Mac
          </Text>
          <Text style={styles.connectedBody}>
            Your Mac cleans up your scans and talks to your printer.
          </Text>
        </View>
        <View style={styles.footer}>
          <Button
            label={
              resume ? 'Done' : canScan ? 'Scan something' : 'Open projects'
            }
            onPress={() =>
              onDone(resume ? 'back' : canScan ? 'scan' : 'projects')
            }
          />
        </View>
      </View>
    );
  }

  if (paired && status) {
    const host = hostOf(status.baseUrl);
    // Checking the paired Mac holds the phone's one request to a Mac, so it
    // stops before pairing another.
    const replace = () => {
      native.cancel().catch(() => {});
      setPhase({ kind: 'scanning' });
      setReplacing(true);
    };
    return (
      <Shell insets={insets} onBack={onBack}>
        <Text accessibilityRole="header" style={styles.title}>
          Your Mac
        </Text>
        <View style={styles.panel}>
          <View style={styles.row}>
            <View
              style={[
                styles.dot,
                {
                  backgroundColor:
                    reachable === true
                      ? colors.pass
                      : reachable === false
                      ? colors.muted
                      : colors.line,
                },
              ]}
            />
            <Text accessibilityLiveRegion="polite" style={styles.panelText}>
              {reachable === null
                ? 'Looking for your Mac…'
                : reachable
                ? 'Connected'
                : refused ?? 'Your phone can’t reach your Mac right now.'}
            </Text>
          </View>
          {reachable === false && !refused ? (
            <Text style={type.caption}>
              Are they on the same Wi-Fi, or is your VPN on?
            </Text>
          ) : null}
        </View>
        {pending ? (
          <View style={styles.panel}>
            <Text style={type.heading}>Pair with another Mac?</Text>
            <Text style={styles.body}>
              This phone is paired with a Mac now. The code you opened pairs it
              with that Mac instead.
            </Text>
            <Button label="Pair with that Mac" onPress={replace} />
            <Button
              label="Keep this Mac"
              variant="secondary"
              onPress={() => setPending(null)}
            />
          </View>
        ) : (
          <>
            <Button
              label="Pair another Mac"
              variant="secondary"
              onPress={() =>
                Alert.alert(
                  'Pair another Mac?',
                  'This phone forgets the Mac it’s paired with now.',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Pair another Mac', onPress: replace },
                  ],
                )
              }
            />
            <Button
              label="Forget this Mac"
              variant="secondary"
              onPress={() =>
                Alert.alert(
                  'Forget this Mac?',
                  'Your projects stay on this phone. You can pair again with a new code.',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Forget',
                      style: 'destructive',
                      onPress: async () => {
                        try {
                          setStatus(await native.disconnect());
                          setPhase({ kind: 'scanning' });
                        } catch (error) {
                          setPhase({
                            kind: 'failed',
                            message:
                              pairingError(error) ??
                              'This phone couldn’t forget the Mac. Try again.',
                          });
                        }
                      },
                    },
                  ],
                )
              }
            />
          </>
        )}
        {phase.kind === 'failed' ? (
          <Text accessibilityRole="alert" style={styles.body}>
            {phase.message}
          </Text>
        ) : null}
        {host ? (
          <Text selectable style={styles.footnote}>
            {host}
          </Text>
        ) : null}
      </Shell>
    );
  }

  const busy = phase.kind === 'pairing';
  // The camera waits for the stored pairing: a paired Mac is replaced only
  // after asking. It's off while a code is in use, and re-arms for the next.
  const armed =
    status !== null && phase.kind === 'scanning' && !readFailed && !paused;
  return (
    <Shell insets={insets} onBack={busy ? undefined : onBack}>
      <Text accessibilityRole="header" style={styles.title}>
        Find your Mac
      </Text>
      <Text style={styles.body}>
        Scan to Make uses your Mac to clean up scans and talk to your printer.
      </Text>
      <View style={[styles.finder, { height: Math.min(380, height * 0.45) }]}>
        <QRViewfinder
          active={armed}
          onCode={value => {
            if (armed) use(value);
          }}
          onState={setCamera}
          style={StyleSheet.absoluteFill}
        />
        {camera === 'denied' ? (
          <Overlay>
            <Text style={styles.overlayText}>
              Scan to Make can’t use the camera.
            </Text>
            <Button
              label="Open Settings"
              onPress={() => Linking.openSettings()}
            />
          </Overlay>
        ) : camera === 'no-camera' ? (
          <Overlay>
            <Text style={styles.overlayText}>This device has no camera.</Text>
          </Overlay>
        ) : null}
        {phase.kind === 'asking' ? (
          <Overlay light>
            <Text style={styles.askTitle}>
              To find your Mac, Scan to Make needs to look on your Wi-Fi.
            </Text>
            <Button
              label="Continue"
              onPress={() => {
                asked.current = true;
                const code = phase.code;
                working.current = true;
                pair(code);
              }}
            />
          </Overlay>
        ) : null}
        {busy ? (
          <Overlay>
            <ActivityIndicator color="#fff" />
            <Text accessibilityLiveRegion="polite" style={styles.overlayText}>
              Pairing with your Mac…
            </Text>
          </Overlay>
        ) : null}
      </View>
      <Text style={styles.caption}>
        Point at the code in Scan to Make on your Mac
      </Text>
      {readFailed ? (
        <View style={styles.panel}>
          <Text style={styles.body}>
            This phone couldn’t read its pairing. Unlock it and try again.
          </Text>
          <Button label="Try again" onPress={readStatus} />
        </View>
      ) : null}
      {phase.kind === 'failed' ? (
        <View style={styles.panel}>
          <Text accessibilityRole="alert" style={styles.body}>
            {phase.message}
          </Text>
          <Button
            label="Try again"
            onPress={() => {
              const retry = phase.retry;
              setPhase({ kind: 'scanning' });
              if (retry) use(retry);
            }}
          />
        </View>
      ) : null}
      <Pressable
        accessibilityRole="button"
        onPress={() =>
          Alert.alert(
            'Get Scan to Make for Mac',
            'Get Scan to Make for Mac from the Scan to Make website on your Mac. It shows a code to scan.',
          )
        }
        style={({ pressed }) => [styles.link, pressed && styles.pressed]}
      >
        <Text style={styles.linkText}>Don’t have the Mac app yet?</Text>
      </Pressable>
    </Shell>
  );
}

function hostOf(baseUrl?: string) {
  const match = /^https?:\/\/([^/?#]+)/i.exec(baseUrl ?? '');
  return match?.[1] ?? null;
}

function Shell({
  insets,
  onBack,
  children,
}: {
  insets: { top: number; bottom: number; left: number; right: number };
  onBack?: () => void;
  children: React.ReactNode;
}) {
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[
        styles.scroll,
        {
          paddingTop: insets.top + space.sm,
          paddingBottom: insets.bottom + space.xl,
          paddingLeft: insets.left + space.xl,
          paddingRight: insets.right + space.xl,
        },
      ]}
    >
      <View style={styles.column}>
        {onBack ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            hitSlop={8}
            onPress={onBack}
            style={({ pressed }) => [styles.back, pressed && styles.pressed]}
          >
            <Text style={styles.backText}>‹</Text>
          </Pressable>
        ) : null}
        {children}
      </View>
    </ScrollView>
  );
}

function Overlay({
  light,
  children,
}: {
  light?: boolean;
  children: React.ReactNode;
}) {
  return (
    <View style={[StyleSheet.absoluteFill, styles.overlay]}>
      <View style={[styles.overlayCard, light && styles.overlayLight]}>
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  scroll: { flexGrow: 1, alignItems: 'center' },
  column: { width: '100%', maxWidth: READABLE_WIDTH, gap: space.lg },
  back: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  },
  backText: { fontSize: 26, lineHeight: 28, color: colors.ink },
  pressed: { opacity: 0.7 },
  title: { ...type.title, fontWeight: '700', letterSpacing: -0.9 },
  body: { ...type.body, color: colors.muted },
  finder: {
    borderRadius: 28,
    overflow: 'hidden',
    backgroundColor: colors.viewport,
  },
  caption: { ...type.body, color: colors.muted, textAlign: 'center' },
  overlay: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.lg,
    backgroundColor: 'rgba(10,12,10,0.45)',
  },
  // Stretched, so the native buttons inside get a real width to draw in.
  overlayCard: {
    width: '100%',
    maxWidth: 320,
    alignItems: 'stretch',
    gap: space.md,
  },
  overlayLight: {
    padding: space.xl,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
  },
  overlayText: {
    ...type.body,
    color: '#fff',
    textAlign: 'center',
    fontWeight: '600',
  },
  askTitle: {
    ...type.body,
    color: colors.ink,
    textAlign: 'center',
    fontWeight: '600',
  },
  panel: {
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  dot: { width: 9, height: 9, borderRadius: 4.5 },
  panelText: { ...type.body, fontWeight: '600', flex: 1 },
  footnote: { ...type.caption, textAlign: 'center' },
  link: { alignSelf: 'center', padding: space.sm },
  linkText: { ...type.body, color: colors.accent, fontWeight: '600' },
  connected: { justifyContent: 'space-between', alignItems: 'center' },
  connectedMiddle: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.lg,
    paddingHorizontal: space.xl,
    maxWidth: READABLE_WIDTH,
  },
  halo: {
    width: 184,
    height: 184,
    borderRadius: 92,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.passSoft,
  },
  check: {
    width: 104,
    height: 104,
    borderRadius: 52,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.pass,
  },
  checkMark: { fontSize: 48, lineHeight: 56, color: '#fff', fontWeight: '700' },
  connectedTitle: {
    fontSize: 28,
    lineHeight: 33,
    fontWeight: '700',
    color: colors.ink,
    textAlign: 'center',
    letterSpacing: -0.6,
  },
  connectedBody: { ...type.body, color: colors.muted, textAlign: 'center' },
  footer: {
    width: '100%',
    maxWidth: READABLE_WIDTH,
    paddingHorizontal: space.lg,
  },
});
