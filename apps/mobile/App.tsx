import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  BackHandler,
  Modal,
  Platform,
  StatusBar,
  Text,
  useColorScheme,
  Linking,
} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type {
  SavedProjects,
  ListProjectsResult,
} from '@scan-to-make/contracts/saved-project';
import { localSavedProjects, newProjectId } from './src/project/savedProjects';
import { CompanionScreen } from './src/screens/CompanionScreen';
import { isPairingLink } from './src/companion/pairingLink';
import { ProjectsHomeScreen } from './src/screens/ProjectsHomeScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { RetainedCapturesScreen } from './src/screens/RetainedCapturesScreen';
import { ScanResultsScreen } from './src/screens/ScanResultsScreen';
import type { ReferenceDraft } from './src/screens/scanResultsModel';
import { CloseUpsScreen } from './src/screens/CloseUpsScreen';
import { PrintScreen } from './src/screens/PrintScreen';
import { liveScanServices } from './src/screens/liveScanServices';
import { RequestGateProvider } from './src/screens/requestGate';
import type { ScanServices, ScanTarget } from './src/screens/scanServices';
import type { ScanProcessingJob } from '@scan-to-make/contracts';
import { Screen } from './src/ui/components';
import { type } from './src/ui/theme';

type Route =
  | 'home'
  | 'settings'
  | 'retainedCaptures'
  | 'scanResults'
  | 'closeUps'
  | 'print';
const PARENT: Record<Route, Route | null> = {
  home: null,
  settings: 'home',
  retainedCaptures: 'home',
  scanResults: 'retainedCaptures',
  closeUps: 'scanResults',
  print: 'scanResults',
};

function App({
  repository: injected,
  scanServices: injectedScan,
}: {
  repository?: SavedProjects;
  scanServices?: ScanServices;
}) {
  const [repository] = useState(() => injected ?? localSavedProjects());
  // Real companion clients on iOS; elsewhere the screens say it's unavailable.
  const [scanServices] = useState(
    () => injectedScan ?? liveScanServices(repository),
  );
  const scheme = useColorScheme();
  const [scanTarget, setScanTarget] = useState<ScanTarget | null>(null);
  // Real-size drafts per scan, so moving to close-ups keeps them.
  const [referenceDrafts, setReferenceDrafts] = useState<
    Record<string, ReferenceDraft>
  >({});
  const scanKey = scanTarget
    ? JSON.stringify([scanTarget.projectId, scanTarget.capture.captureId])
    : '';
  // The finished scan check whose cleaned-up model Send to printer uses.
  const [printJob, setPrintJob] = useState<ScanProcessingJob | null>(null);
  const [companionOpen, setCompanionOpen] = useState(false);
  // Bumped when the pairing screen closes, so home reads the pairing again.
  const [pairingKey, setPairingKey] = useState(0);
  // scantomake://pair links, e.g. the companion's QR read by the Camera app.
  const [pairLink, setPairLink] = useState<string | null>(null);
  // A cold start can deliver the same link twice within moments. Drop that
  // repeat, but let the user open the same link again later to retry.
  const lastLink = useRef<{ url: string; at: number } | null>(null);
  useEffect(() => {
    const open = (url?: string | null) => {
      if (!url || !isPairingLink(url)) return;
      const now = Date.now();
      const last = lastLink.current;
      lastLink.current = { url, at: now };
      if (last?.url === url && now - last.at < 2000) return;
      setPairLink(url);
      setCompanionOpen(true);
    };
    Linking.getInitialURL().then(open, () => {});
    const subscription = Linking.addEventListener('url', event =>
      open(event.url),
    );
    return () => subscription.remove();
  }, []);
  const [route, setRoute] = useState<Route>('home');
  const [hydrated, setHydrated] = useState(false);
  const [listing, setListing] = useState<ListProjectsResult | null>(null);
  const [captureProjectId, setCaptureProjectId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // The grid keeps showing while it reloads.
  const refresh = useCallback(async () => {
    const result = await repository.list();
    setListing(result);
    setHydrated(true);
  }, [repository]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (creating) {
        return true;
      }
      const parent = PARENT[route];
      if (parent) {
        setRoute(parent);
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [route, creating]);
  const openCaptures = (id: string) => {
    setCaptureProjectId(id);
    setRoute('retainedCaptures');
  };
  const createProject = async (name: string) => {
    setCreating(true);
    setCreateError(null);
    let result: Awaited<ReturnType<SavedProjects['create']>>;
    try {
      result = await repository.create({
        id: newProjectId(),
        brief: { object: name, context: '', addition: '' },
      });
    } catch {
      result = { status: 'storage-error' };
    } finally {
      setCreating(false);
    }
    if (result.status !== 'ok') {
      setCreateError(
        'The project couldn’t be saved. Your other projects are unchanged.',
      );
      await refresh();
      return false;
    }
    await refresh();
    openCaptures(result.project.id);
    return true;
  };
  let screen: React.ReactNode;
  if (!hydrated) {
    screen = (
      <Screen title="Opening your projects">
        <Text style={type.body}>Loading saved data…</Text>
      </Screen>
    );
  } else
    switch (route) {
      case 'retainedCaptures':
        screen = captureProjectId ? (
          <RetainedCapturesScreen
            id={captureProjectId}
            repository={repository}
            onBack={() => {
              refresh();
              setRoute('home');
            }}
            onCompanion={() => setCompanionOpen(true)}
            onResults={capture => {
              setScanTarget({ projectId: captureProjectId, capture });
              setRoute('scanResults');
            }}
          />
        ) : null;
        break;
      case 'scanResults':
        screen = scanTarget ? (
          <ScanResultsScreen
            target={scanTarget}
            services={scanServices}
            onBack={() => setRoute('retainedCaptures')}
            onCompanion={() => setCompanionOpen(true)}
            onCloseUps={() => setRoute('closeUps')}
            onPrint={
              scanServices.printing
                ? job => {
                    setPrintJob(job);
                    setRoute('print');
                  }
                : undefined
            }
            reference={referenceDrafts[scanKey] ?? null}
            onReferenceChange={draft =>
              setReferenceDrafts(current => ({ ...current, [scanKey]: draft }))
            }
          />
        ) : null;
        break;
      case 'print':
        screen = scanTarget ? (
          <PrintScreen
            target={scanTarget}
            job={printJob}
            services={scanServices}
            onBack={() => setRoute('scanResults')}
            onCompanion={() => setCompanionOpen(true)}
          />
        ) : null;
        break;
      case 'closeUps':
        screen = scanTarget ? (
          <CloseUpsScreen
            target={scanTarget}
            services={scanServices}
            onBack={() => setRoute('scanResults')}
            onCompanion={() => setCompanionOpen(true)}
          />
        ) : null;
        break;
      case 'settings':
        screen = (
          <SettingsScreen
            onPair={() => setCompanionOpen(true)}
            onBack={() => setRoute('home')}
          />
        );
        break;
      default:
        screen = (
          <ProjectsHomeScreen
            result={listing}
            services={scanServices}
            pairingKey={pairingKey}
            paused={companionOpen}
            creating={creating}
            createError={createError}
            onCreate={createProject}
            onNaming={() => setCreateError(null)}
            onOpen={openCaptures}
            onRetry={refresh}
            onPair={() => setCompanionOpen(true)}
            onSettings={() => setRoute('settings')}
          />
        );
    }
  return (
    <SafeAreaProvider>
      {/* One queue for every companion call, across screens. */}
      <RequestGateProvider>
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
            <CompanionScreen
              onBack={() => {
                setCompanionOpen(false);
                setPairingKey(key => key + 1);
              }}
              link={pairLink}
              onLinkUsed={() => setPairLink(null)}
            />
          </Modal>
        ) : null}
      </RequestGateProvider>
    </SafeAreaProvider>
  );
}
export default App;
