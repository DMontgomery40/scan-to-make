import React, { useEffect, useRef, useState } from 'react';
import {
  BackHandler,
  Linking,
  Modal,
  Platform,
  StatusBar,
  StyleSheet,
  View,
  useColorScheme,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { companionNative } from './src/companion/pairing';
import { isPairingLink } from './src/companion/pairingLink';
import { KeepPairingFresh } from './src/companion/keepPairingFresh';
import {
  FindYourMacScreen,
  type AfterPairing,
} from './src/screens/FindYourMacScreen';
import { RequestGateProvider } from './src/screens/requestGate';
import { ObjectsScreen } from './src/screens/ObjectsScreen';
import { ObjectScreen } from './src/screens/ObjectScreen';
import { StartScreen } from './src/screens/StartScreen';
import { ObjectsClient } from './src/objects/client';
import { objectsNative, type ObjectsNative } from './src/objects/native';
import { objectCapture, type ObjectCapture } from './src/objects/capture';
import { colors } from './src/ui/theme';

type Route =
  | { name: 'objects' }
  | { name: 'start' }
  | { name: 'object'; id: string };

/** Without the native module (tests, Android) every call says to connect. */
const unpaired: ObjectsNative = new Proxy({} as ObjectsNative, {
  get: () => () =>
    Promise.reject(
      Object.assign(new Error('Not paired'), { code: 'pairing-required' }),
    ),
});

/** Wide windows (an open iPhone Duo, iPad) show the list and a page side by side. */
const TWO_PANES = 700;

function App({
  objects: injected,
  capture: injectedCapture,
}: {
  objects?: ObjectsClient;
  capture?: ObjectCapture;
}) {
  const [client] = useState(
    () => injected ?? new ObjectsClient(objectsNative() ?? unpaired),
  );
  const [capture] = useState(() => injectedCapture ?? objectCapture());
  const scheme = useColorScheme();
  const { width } = useWindowDimensions();
  const twoPanes = width >= TWO_PANES;
  const [route, setRoute] = useState<Route>({ name: 'objects' });
  // The last object opened stays on the right in the two-pane layout.
  const [shown, setShown] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [companionOpen, setCompanionOpen] = useState(false);
  const [canScan, setCanScan] = useState(false);
  useEffect(() => {
    capture.available().then(setCanScan, () => {});
  }, [capture]);
  // With no Mac paired, Find your Mac is the first screen. A pairing that
  // can't be read leaves the list in place.
  const [needsMac, setNeedsMac] = useState(false);
  const [pairingKey, setPairingKey] = useState(0);
  useEffect(() => {
    let live = true;
    companionNative()
      ?.status()
      .then(
        value => live && setNeedsMac(value.state !== 'paired'),
        () => {},
      );
    return () => {
      live = false;
    };
  }, [pairingKey]);
  // True while Find your Mac is the screen on show, so a link goes to it.
  const findingMac = useRef(false);
  findingMac.current = needsMac;
  // scantomake://pair links, e.g. the Mac's QR read by the Camera app. A cold
  // start can deliver the same link twice within moments: drop that repeat.
  const [pairLink, setPairLink] = useState<string | null>(null);
  const lastLink = useRef<{ url: string; at: number } | null>(null);
  useEffect(() => {
    const open = (url?: string | null) => {
      if (!url || !isPairingLink(url)) return;
      const now = Date.now();
      const last = lastLink.current;
      lastLink.current = { url, at: now };
      if (last?.url === url && now - last.at < 2000) return;
      setPairLink(url);
      if (!findingMac.current) setCompanionOpen(true);
    };
    Linking.getInitialURL().then(open, () => {});
    const subscription = Linking.addEventListener('url', event =>
      open(event.url),
    );
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (route.name === 'objects') return false;
      setRoute({ name: 'objects' });
      return true;
    });
    return () => sub.remove();
  }, [route]);

  const afterPairing = (next: AfterPairing) => {
    setCompanionOpen(false);
    setNeedsMac(false);
    setPairingKey(key => key + 1);
    setRefreshKey(key => key + 1);
    if (next === 'back') return;
    setRoute(next === 'scan' ? { name: 'start' } : { name: 'objects' });
  };
  const pair = () => setCompanionOpen(true);
  const open = (id: string) => {
    setShown(id);
    setRoute({ name: 'object', id });
  };
  const toList = () => {
    setRefreshKey(key => key + 1);
    setRoute({ name: 'objects' });
  };

  const list = (
    <ObjectsScreen
      client={client}
      selected={twoPanes ? shown : null}
      refreshKey={refreshKey}
      onNew={() => setRoute({ name: 'start' })}
      onOpen={open}
      onPair={pair}
    />
  );
  const start = (
    <StartScreen
      client={client}
      capture={capture}
      onBack={toList}
      onStarted={id => {
        setRefreshKey(key => key + 1);
        open(id);
      }}
      onPair={pair}
    />
  );
  const page = (id: string, back?: () => void) => (
    <ObjectScreen
      key={id}
      client={client}
      capture={capture}
      id={id}
      onBack={back}
      onPair={pair}
    />
  );

  let screen: React.ReactNode;
  if (needsMac)
    screen = (
      <FindYourMacScreen
        onDone={afterPairing}
        canScan={canScan}
        // One camera at a time: this one waits under an open sheet.
        paused={companionOpen}
        link={companionOpen ? null : pairLink}
        onLinkUsed={() => setPairLink(null)}
      />
    );
  else if (twoPanes) {
    const right =
      route.name === 'start'
        ? start
        : route.name === 'object'
        ? page(route.id)
        : shown
        ? page(shown)
        : null;
    screen = (
      <View style={styles.panes}>
        <View style={styles.list}>{list}</View>
        <View style={styles.page}>{right}</View>
      </View>
    );
  } else
    screen =
      route.name === 'start'
        ? start
        : route.name === 'object'
        ? page(route.id, toList)
        : list;

  return (
    <SafeAreaProvider>
      {/* One queue for every call to the Mac, across screens. */}
      <RequestGateProvider>
        {/* Keeps the paired Mac's credential alive, in the same queue. */}
        <KeepPairingFresh onPairAgain={() => setPairingKey(key => key + 1)} />
        <StatusBar
          barStyle={
            Platform.OS === 'ios' && scheme === 'dark'
              ? 'light-content'
              : 'dark-content'
          }
        />
        {screen}
        {companionOpen ? (
          <Modal
            presentationStyle="fullScreen"
            onRequestClose={() => {
              setCompanionOpen(false);
              setPairingKey(key => key + 1);
            }}
          >
            <FindYourMacScreen
              onBack={() => {
                setCompanionOpen(false);
                setPairingKey(key => key + 1);
              }}
              onDone={afterPairing}
              canScan={canScan}
              resume={route.name !== 'objects'}
              link={pairLink}
              onLinkUsed={() => setPairLink(null)}
            />
          </Modal>
        ) : null}
      </RequestGateProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  panes: { flex: 1, flexDirection: 'row', backgroundColor: colors.background },
  list: {
    width: 360,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: colors.line,
  },
  page: { flex: 1 },
});

export default App;
