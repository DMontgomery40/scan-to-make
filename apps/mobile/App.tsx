import React, { useEffect, useState } from 'react';
import { BackHandler, StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { PlaceholderCupHolderFitSpec } from './src/contracts/placeholder';
import { CaptureScreen } from './src/screens/CaptureScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { PreviewScreen } from './src/screens/PreviewScreen';
import { SpikeScreen } from './src/screens/SpikeScreen';

type Route = 'home' | 'capture' | 'preview' | 'spike';

const PARENT: Record<Route, Route | null> = {
  home: null,
  capture: 'home',
  preview: 'capture',
  spike: 'home',
};

function App() {
  const [route, setRoute] = useState<Route>('home');
  const [spec, setSpec] = useState<PlaceholderCupHolderFitSpec | null>(null);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const parent = PARENT[route];
      if (parent) {
        setRoute(parent);
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [route]);

  let screen: React.ReactNode;
  switch (route) {
    case 'capture':
      screen = (
        <CaptureScreen
          initial={spec}
          onBack={() => setRoute('home')}
          onConfirm={next => {
            setSpec(next);
            setRoute('preview');
          }}
        />
      );
      break;
    case 'preview':
      screen = spec ? (
        <PreviewScreen
          spec={spec}
          onEdit={() => setRoute('capture')}
          onBack={() => setRoute('capture')}
        />
      ) : null;
      break;
    case 'spike':
      screen = <SpikeScreen onBack={() => setRoute('home')} />;
      break;
    default:
      screen = (
        <HomeScreen
          onStartScan={() => setRoute('capture')}
          onOpenSpike={() => setRoute('spike')}
        />
      );
  }

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      {screen}
    </SafeAreaProvider>
  );
}

export default App;
