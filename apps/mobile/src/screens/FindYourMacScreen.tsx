import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
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
  pairWithInvitation,
  UNREACHABLE,
  type CompanionNative,
  type PairingStatus,
} from '../companion/pairing';
import { parsePairingQR } from '../companion/pairingLink';
import {
  formatNearbyCode,
  nearbyNative,
  pairNearby,
  type NearbyMac,
  type NearbyNative,
  type NearbyStarted,
} from '../companion/nearby';
import { QRViewfinder, type ViewfinderState } from '../companion/QRViewfinder';
import { Button, READABLE_WIDTH } from '../ui/components';
import { useRequestGate } from './requestGate';
import { colors, radius, space, type } from '../ui/theme';

/** What to open once this phone is paired; 'back' returns to where it began. */
export type AfterPairing = 'scan' | 'projects' | 'back';

type Phase =
  | { kind: 'scanning' }
  // The one sentence shown before iOS asks about the local network.
  | { kind: 'asking'; code: string }
  | { kind: 'pairing' }
  | { kind: 'failed'; message: string; retry?: string; nearby?: boolean }
  // Nearby (Bonjour) pairing: the code to compare once the Mac has it.
  | { kind: 'nearby'; mac: NearbyMac; started?: NearbyStarted }
  | { kind: 'connected' };

/** What the nearby search has found, separate from the camera's phase. */
type Nearby = 'idle' | 'looking' | 'none' | 'denied' | NearbyMac[];
const CLOSED = () => Object.assign(Error('Closed'), { code: 'cancelled' });

const DEVICE_NAME = 'My phone';
const OUT_OF_REACH = new Set(['network', 'timeout']);
// Your Mac no longer accepts this phone's credential.
const TURNED_AWAY = new Set(['unauthorized', 'forbidden', 'pairing-required']);
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
  nearby = nearbyNative(),
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
  /** Bonjour pairing with a Mac on this Wi-Fi; absent in builds without it. */
  nearby?: NearbyNative;
  /** A pairing link the app was opened with, e.g. from the Camera app. */
  link?: string | null;
  onLinkUsed?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const gate = useRequestGate();
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
  // False once the screen has closed: a request still waiting its turn in
  // the queue then never starts (native.cancel() stops only a running one).
  const open = useRef(true);
  useEffect(() => {
    if (!native) return;
    open.current = true;
    readStatus();
    return () => {
      open.current = false;
      native.cancel().catch(() => {});
    };
  }, [native]); // eslint-disable-line react-hooks/exhaustive-deps

  const paired = status?.state === 'paired' && !replacing;
  // An already-paired phone checks its Mac once, to say whether it answers.
  useEffect(() => {
    if (!native || !paired || phase.kind === 'connected') return;
    let live = true;
    // In the app's one queue, so it never meets a refresh as "busy".
    gate(() => native.check())
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
          NOT_ANSWERING.has(code)
            ? null
            : // Revoked, or its credential ran out: pair again (KAN-182).
            TURNED_AWAY.has(code)
            ? pairingError({ code: 'pairing-required' }) ?? null
            : pairingError(error) ?? null,
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
      // Queued like every other request, so a refresh waiting its turn
      // can't take the phone's one request first. v1 codes pair at their
      // one address; v2 codes try every address with the key pin.
      const result = await gate(() => {
        if (!open.current)
          throw Object.assign(Error('Closed'), { code: 'cancelled' });
        return pairWithInvitation(native, parsed, DEVICE_NAME);
      });
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
      // A pinned code (v1 certificate or v2 public key) means a Mac on the local network.
      if ((parsed.certificateSha256 || parsed.publicKeySha256) && !asked.current) {
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

  // Nearby pairing (journey P7): after the Wi-Fi sentence, look for a Mac
  // on this Wi-Fi; Pair shows the code both screens share, then Allow on the
  // Mac pairs it. The camera stays for the QR path the whole time.
  const [found, setFound] = useState<Nearby>('idle');
  // True while this screen has native nearby work it started: a session, or
  // the Bonjour browser, which keeps running after browse() returns. Only
  // this screen cancels it, and cancelling stops both.
  const nearbyOwned = useRef(false);
  // A browse() still waiting for its list.
  const searching = useRef(false);
  // The final pairing request is running on the companion bridge.
  const companionBusy = useRef(false);
  // `working` is held by a nearby attempt (not by a QR or link pairing).
  const nearbyHolds = useRef(false);
  // Bumped by every Pair and Cancel: an older attempt's late answer is ignored.
  const attempt = useRef(0);
  const look = async () => {
    // Like the camera, it waits until the stored pairing is read.
    if (!nearby || paused || status === null || searching.current || working.current) return;
    asked.current = true;
    searching.current = true;
    nearbyOwned.current = true;
    setFound('looking');
    // A search stopped on the way (the screen was covered) changes nothing.
    const mine = attempt.current;
    const current = () => open.current && attempt.current === mine;
    try {
      const macs = await nearby.browse(3000);
      if (current()) setFound(macs.length ? macs : 'none');
    } catch (error) {
      if (current())
        setFound((error as { code?: string })?.code === 'local-network' ? 'denied' : 'none');
    } finally {
      searching.current = false;
    }
  };
  const pairWith = async (mac: NearbyMac) => {
    if (!nearby || !native || paused || status === null || working.current || searching.current) return;
    working.current = true;
    nearbyHolds.current = true;
    nearbyOwned.current = true;
    const mine = ++attempt.current;
    const current = () => open.current && attempt.current === mine;
    setPhase({ kind: 'nearby', mac });
    // Waiting for Allow doesn't hold the app's queue; only the pairing itself
    // waits its turn, and never starts once this attempt is over.
    const companion: CompanionNative = {
      status: () => native.status(),
      pair: (baseUrl, code, deviceName, pin) =>
        gate(async () => {
          if (!current()) throw CLOSED();
          companionBusy.current = true;
          try {
            return await native.pair(baseUrl, code, deviceName, pin);
          } finally {
            companionBusy.current = false;
          }
        }),
      pairAddresses: (addresses, code, deviceName, key) =>
        gate(async () => {
          if (!current()) throw CLOSED();
          companionBusy.current = true;
          try {
            return await native.pairAddresses(addresses, code, deviceName, key);
          } finally {
            companionBusy.current = false;
          }
        }),
      check: () => native.check(),
      disconnect: () => native.disconnect(),
      cancel: () => native.cancel(),
    };
    try {
      const result = await pairNearby(nearby, companion, mac.name, DEVICE_NAME, started => {
        if (current()) setPhase({ kind: 'nearby', mac, started });
      });
      if (!current()) return;
      setStatus(result);
      setReplacing(false);
      setReachable(true);
      setPhase({ kind: 'connected' });
    } catch (error) {
      if (!current()) return;
      setPhase(
        (error as { code?: string })?.code === 'cancelled'
          ? { kind: 'scanning' }
          : {
              kind: 'failed',
              nearby: true,
              message:
                pairingError(error) ??
                'Pairing didn’t finish. Try again, then click Allow on your Mac.',
            },
      );
    } finally {
      if (attempt.current === mine) {
        working.current = false;
        nearbyHolds.current = false;
      }
    }
  };
  // Ends this screen's native nearby work: the session and the browser.
  const halt = () => {
    attempt.current++;
    // Only a nearby attempt's hold is released: a QR pairing keeps its own.
    if (nearbyHolds.current) {
      nearbyHolds.current = false;
      working.current = false;
    }
    if (nearbyOwned.current) {
      nearbyOwned.current = false;
      nearby?.cancel().catch(() => {});
    }
    // After Allow the pairing itself may be running: stop that too.
    if (companionBusy.current) native?.cancel().catch(() => {});
  };
  // Cancel: nothing to apologise for. Cancelling forgets the Macs found, so
  // look again for the card to come back.
  const stopNearby = () => {
    halt();
    setPhase({ kind: 'scanning' });
    look();
  };
  // Covered by another screen: stop only what this screen started.
  useEffect(() => {
    if (!paused || !nearbyOwned.current) return;
    halt();
    setPhase(current => (current.kind === 'nearby' ? { kind: 'scanning' } : current));
    setFound('idle');
  }, [paused]); // eslint-disable-line react-hooks/exhaustive-deps
  // Back from Settings with Local Network turned on: look again by itself.
  useEffect(() => {
    if (found !== 'denied') return;
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') look();
    });
    return () => subscription.remove();
  }, [found]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(
    () => () => {
      if (nearbyOwned.current) nearby?.cancel().catch(() => {});
    },
    [nearby],
  );

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
              const nearbyFailed = phase.nearby;
              setPhase({ kind: 'scanning' });
              if (retry) use(retry);
              // The Mac forgets an ended session; look again for its card.
              else if (nearbyFailed) look();
            }}
          />
        </View>
      ) : null}
      {nearby && phase.kind === 'nearby' ? (
        <View style={styles.panel}>
          {phase.started ? (
            <>
              <Text accessibilityRole="header" style={type.heading}>
                {`Pair with ${phase.mac.name}?`}
              </Text>
              <Text
                accessibilityLabel={phase.started.code.split('').join(' ')}
                style={styles.nearbyCode}
              >
                {formatNearbyCode(phase.started.code)}
              </Text>
              <Text style={styles.body}>
                Make sure your Mac shows the same number, then click Allow on your Mac.
              </Text>
            </>
          ) : null}
          <View style={styles.row}>
            <ActivityIndicator />
            <Text accessibilityLiveRegion="polite" style={styles.panelText}>
              {phase.started ? 'Waiting for your Mac…' : `Asking ${phase.mac.name}…`}
            </Text>
          </View>
          <Button label="Cancel" variant="secondary" onPress={stopNearby} />
        </View>
      ) : nearby && phase.kind === 'scanning' && status !== null && !readFailed ? (
        found === 'idle' ? (
          <View style={styles.panel}>
            <Text style={styles.body}>
              To find your Mac, Scan to Make needs to look on your Wi-Fi.
            </Text>
            <Button label="Continue" variant="secondary" disabled={paused} onPress={look} />
          </View>
        ) : found === 'looking' ? (
          <View style={styles.row}>
            <ActivityIndicator />
            <Text accessibilityLiveRegion="polite" style={styles.body}>
              Looking for your Mac on this Wi-Fi…
            </Text>
          </View>
        ) : found === 'denied' ? (
          <View style={styles.panel}>
            <Text style={styles.body}>Scan to Make can’t look on your Wi-Fi.</Text>
            <Button
              label="Open Settings"
              variant="secondary"
              onPress={() => Linking.openSettings()}
            />
            <Button label="Look again" variant="secondary" onPress={look} />
          </View>
        ) : found === 'none' ? (
          <View style={styles.row}>
            <Text style={styles.body}>No Mac found on this Wi-Fi.</Text>
            <Pressable
              accessibilityRole="button"
              onPress={look}
              style={({ pressed }) => [styles.link, pressed && styles.pressed]}
            >
              <Text style={styles.linkText}>Look again</Text>
            </Pressable>
          </View>
        ) : (
          found.map(mac => (
            <View key={mac.name} style={styles.panel}>
              <Text style={type.caption}>Mac found nearby</Text>
              <Text style={type.heading}>{mac.name}</Text>
              <Text style={styles.body}>On this Wi-Fi</Text>
              <Button label="Pair" disabled={paused} onPress={() => pairWith(mac)} />
            </View>
          ))
        )
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
  // The number both screens show, read side by side with the Mac.
  nearbyCode: {
    fontSize: 40,
    lineHeight: 46,
    fontWeight: '700',
    letterSpacing: 2,
    color: colors.ink,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
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
