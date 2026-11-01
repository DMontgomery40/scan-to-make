import React, { useEffect, useRef, useState } from 'react';
import {
  Linking,
  Modal,
  Platform,
  StatusBar,
  StyleSheet,
  Text,
  UIManager,
  View,
  requireNativeComponent,
  useColorScheme,
  type ViewStyle,
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
import { objectCaptureNative } from './src/capture/nativeObjectCapture';
import { colors, type } from './src/ui/theme';

/**
 * The app itself is native SwiftUI (ios/ScanToMake/Objects/ObjectsApp.swift):
 * iOS 27's own navigation, lists, sheets and Liquid Glass controls. This shell
 * keeps what already works in React Native: pairing with the Mac, pairing
 * links, and keeping the credential fresh.
 */
type ObjectsAppProps = {
  style: ViewStyle;
  pairingKey: number;
  onPair: () => void;
};
const NativeObjectsApp =
  Platform.OS === 'ios' && UIManager.getViewManagerConfig?.('STMObjectsApp')
    ? requireNativeComponent<ObjectsAppProps>('STMObjectsApp')
    : null;

function ObjectsApp(props: ObjectsAppProps) {
  if (NativeObjectsApp) return <NativeObjectsApp {...props} />;
  return (
    <View style={[props.style, styles.unavailable]}>
      <Text style={type.body}>Counterpart needs an iPhone or iPad.</Text>
    </View>
  );
}

function App() {
  const scheme = useColorScheme();
  const [companionOpen, setCompanionOpen] = useState(false);
  // Bumped when pairing changes, so the app reads the pairing and its objects again.
  const [pairingKey, setPairingKey] = useState(0);
  // With no Mac paired, Find your Mac is the first screen. A pairing that
  // can't be read leaves the app in place.
  const [needsMac, setNeedsMac] = useState(false);
  const [canScan, setCanScan] = useState(false);
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

  const afterPairing = (_next: AfterPairing) => {
    setCompanionOpen(false);
    setNeedsMac(false);
    setPairingKey(key => key + 1);
  };
  const closePairing = () => {
    setCompanionOpen(false);
    setPairingKey(key => key + 1);
  };

  return (
    <SafeAreaProvider>
      {/* One queue for every call to the Mac from the shell. */}
      <RequestGateProvider>
        {/* Keeps the paired Mac's credential alive. */}
        <KeepPairingFresh onPairAgain={() => setPairingKey(key => key + 1)} />
        <StatusBar
          barStyle={
            Platform.OS === 'ios' && scheme === 'dark'
              ? 'light-content'
              : 'dark-content'
          }
        />
        {needsMac ? (
          <FindYourMacScreen
            onDone={afterPairing}
            canScan={canScan}
            // One camera at a time: this one waits under an open sheet.
            paused={companionOpen}
            link={companionOpen ? null : pairLink}
            onLinkUsed={() => setPairLink(null)}
          />
        ) : (
          <ObjectsApp
            style={styles.app}
            pairingKey={pairingKey}
            onPair={() => setCompanionOpen(true)}
          />
        )}
        {companionOpen ? (
          <Modal presentationStyle="fullScreen" onRequestClose={closePairing}>
            <FindYourMacScreen
              onBack={closePairing}
              onDone={afterPairing}
              canScan={canScan}
              resume
              link={pairLink}
              onLinkUsed={() => setPairLink(null)}
            />
          </Modal>
        ) : null}
        <ScanSupport onChange={setCanScan} />
      </RequestGateProvider>
    </SafeAreaProvider>
  );
}

/** Whether this device can scan (LiDAR), for the pairing screen's wording. */
function ScanSupport({ onChange }: { onChange: (canScan: boolean) => void }) {
  useEffect(() => {
    objectCaptureNative()
      ?.status()
      .then(
        (value: { supported: boolean; lidar?: boolean }) =>
          onChange(value.supported && value.lidar !== false),
        () => {},
      );
  }, [onChange]);
  return null;
}

const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: colors.background },
  unavailable: { alignItems: 'center', justifyContent: 'center', padding: 24 },
});

export default App;
