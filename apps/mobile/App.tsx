import React, { useCallback, useEffect, useState } from 'react';
import { BackHandler, StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { FitSpec, FitSpecPatch } from '@scan-to-make/contracts';
import { seedSpec } from './src/fit/fitDraft';
import {
  memoryFitSpecStore,
  StaleRevisionError,
  type FitSpecStore,
} from './src/project/fitSpecStore';
import { CaptureScreen } from './src/screens/CaptureScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { PreviewScreen } from './src/screens/PreviewScreen';
import { AboutScreen } from './src/screens/AboutScreen';
import { BriefScreen, BriefReviewScreen } from './src/screens/BriefScreen';
import {
  briefComplete,
  emptyBrief,
  type ProjectBrief,
} from './src/project/projectBrief';
import { SpikeScreen } from './src/screens/SpikeScreen';

type Route =
  | 'home'
  | 'brief'
  | 'briefReview'
  | 'capture'
  | 'preview'
  | 'about'
  | 'spike';

const PARENT: Record<Route, Route | null> = {
  home: null,
  brief: 'home',
  briefReview: 'home',
  about: 'home',
  capture: 'home',
  preview: 'capture',
  spike: 'about',
};

function App({ store: injectedStore }: { store?: FitSpecStore }) {
  const [store] = useState(() => injectedStore ?? memoryFitSpecStore());
  const [route, setRoute] = useState<Route>('home');
  const [spec, setSpec] = useState<FitSpec | null>(null);
  const [saving, setSaving] = useState(false);
  const [brief, setBrief] = useState<ProjectBrief>(emptyBrief);

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

  // Every edit goes through the store as an expected-revision patch. On a stale
  // revision the latest spec replaces what is on screen before the error is
  // rethrown, so a preview never keeps showing an outdated revision.
  const submitPatch = useCallback(
    async (patch: FitSpecPatch): Promise<FitSpec> => {
      setSaving(true);
      try {
        let target = spec;
        if (!target) {
          target = await store.create(seedSpec());
          setSpec(target);
        }
        try {
          const next = await store.applyPatch(target.id, patch);
          setSpec(next);
          return next;
        } catch (error) {
          if (error instanceof StaleRevisionError) {
            const latest = await store.get(target.id);
            if (latest) {
              setSpec(latest);
            }
          }
          throw error;
        }
      } finally {
        setSaving(false);
      }
    },
    [spec, store],
  );

  let screen: React.ReactNode;
  switch (route) {
    case 'brief':
      screen = (
        <BriefScreen
          brief={brief}
          onChange={setBrief}
          onBack={() => setRoute('home')}
          onReview={() => {
            setRoute('briefReview');
          }}
        />
      );
      break;
    case 'briefReview':
      screen = (
        <BriefReviewScreen
          brief={brief}
          onBack={() => setRoute('home')}
          onEdit={() => setRoute('brief')}
          onExample={() => setRoute('capture')}
        />
      );
      break;
    case 'about':
      screen = (
        <AboutScreen
          onBack={() => setRoute('home')}
          onOpenSpike={() => setRoute('spike')}
        />
      );
      break;
    case 'capture':
      screen = (
        <CaptureScreen
          base={spec ?? seedSpec()}
          saving={saving}
          onBack={() => setRoute('home')}
          onSubmit={async patch => {
            await submitPatch(patch);
            setRoute('preview');
          }}
        />
      );
      break;
    case 'preview':
      screen = spec ? (
        <PreviewScreen
          spec={spec}
          saving={saving}
          onPatch={submitPatch}
          onEdit={() => setRoute('capture')}
          onBack={() => setRoute('capture')}
        />
      ) : null;
      break;
    case 'spike':
      screen = <SpikeScreen onBack={() => setRoute('about')} />;
      break;
    default:
      screen = (
        <HomeScreen
          onStartScan={() => setRoute('capture')}
          brief={
            Object.values(brief).some(value => value.trim()) ? brief : null
          }
          onNewProject={() => setRoute('brief')}
          onOpenBrief={() =>
            setRoute(briefComplete(brief) ? 'briefReview' : 'brief')
          }
          onAbout={() => setRoute('about')}
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
