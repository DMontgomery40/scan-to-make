import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  BackHandler,
  Modal,
  Platform,
  StatusBar,
  Text,
  useColorScheme,
} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  applyFitSpecPatch,
  type FitSpec,
  type FitSpecPatch,
} from '@scan-to-make/contracts';
import type {
  SavedProjects,
  SavedProject,
  ListProjectsResult,
  WriteProjectResult,
} from '@scan-to-make/contracts/saved-project';
import { seedSpec } from './src/fit/fitDraft';
import { StaleRevisionError } from './src/project/fitSpecStore';
import { localSavedProjects, newProjectId } from './src/project/savedProjects';
import { CompanionScreen } from './src/screens/CompanionScreen';
import { DrawerScreen } from './src/screens/DrawerScreen';
import { CaptureScreen } from './src/screens/CaptureScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { PreviewScreen } from './src/screens/PreviewScreen';
import { AboutScreen } from './src/screens/AboutScreen';
import { BriefScreen, BriefReviewScreen } from './src/screens/BriefScreen';
import { RetainedCapturesScreen } from './src/screens/RetainedCapturesScreen';
import { InspectedFilesScreen } from './src/screens/InspectedFilesScreen';
import { ProjectsScreen } from './src/screens/ProjectsScreen';
import { ScanResultsScreen } from './src/screens/ScanResultsScreen';
import { CloseUpsScreen } from './src/screens/CloseUpsScreen';
import { MakeScreen, type MakeIdea } from './src/screens/MakeScreen';
import {
  unavailableScanServices,
  type ScanServices,
  type ScanTarget,
} from './src/screens/scanServices';
import {
  briefComplete,
  emptyBrief,
  type ProjectBrief,
} from './src/project/projectBrief';
import { SpikeScreen } from './src/screens/SpikeScreen';
import { Screen } from './src/ui/components';
import { type } from './src/ui/theme';

type Route =
  | 'home'
  | 'brief'
  | 'briefReview'
  | 'capture'
  | 'preview'
  | 'about'
  | 'spike'
  | 'inspectedFiles'
  | 'retainedCaptures'
  | 'projects'
  | 'drawer'
  | 'scanResults'
  | 'closeUps'
  | 'make';
const PARENT: Record<Route, Route | null> = {
  home: null,
  brief: 'home',
  briefReview: 'home',
  about: 'home',
  capture: 'home',
  preview: 'capture',
  spike: 'about',
  projects: 'home',
  retainedCaptures: 'projects',
  inspectedFiles: 'projects',
  drawer: 'home',
  scanResults: 'retainedCaptures',
  closeUps: 'scanResults',
  make: 'scanResults',
};
const failure = (result: WriteProjectResult) =>
  result.status === 'stale' || result.status === 'exists'
    ? 'A newer saved version exists. Your draft is still here. Open saved projects to review it, or save this draft as a separate project.'
    : result.status === 'unsupported-version'
    ? 'This project needs a newer app. Your draft and stored data are unchanged.'
    : result.status === 'corrupt'
    ? 'The saved project couldn’t be read. Your draft and stored data are unchanged.'
    : 'Couldn’t confirm the save. Your draft is still here. Check saved projects before trying again.';

function App({
  repository: injected,
  scanServices: injectedScan,
}: {
  repository?: SavedProjects;
  scanServices?: ScanServices;
}) {
  const [repository] = useState(() => injected ?? localSavedProjects());
  // Until the processing and close-up transports ship, these report that the
  // feature is unavailable rather than pretending to work.
  const [scanServices] = useState(
    () => injectedScan ?? unavailableScanServices(),
  );
  const scheme = useColorScheme();
  const [scanTarget, setScanTarget] = useState<ScanTarget | null>(null);
  // Kept for this app session; design planning has no endpoint yet.
  const [makeIdeas, setMakeIdeas] = useState<Record<string, MakeIdea>>({});
  const [companionOpen, setCompanionOpen] = useState(false);
  const [route, setRoute] = useState<Route>('home');
  const [hydrated, setHydrated] = useState(false);
  const [listing, setListing] = useState<ListProjectsResult | null>(null);
  const [briefProject, setBriefProject] = useState<SavedProject | null>(null);
  const [brief, setBrief] = useState<ProjectBrief>(emptyBrief);
  const [measured, setMeasured] = useState<SavedProject | null>(null);
  const [drawer, setDrawer] = useState<SavedProject | null>(null);
  const [captureProjectId, setCaptureProjectId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('Not saved yet');
  const [saveFailed, setSaveFailed] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const spec =
    measured?.fit?.template === 'cup-holder-adapter' ? measured.fit : null;
  const refresh = useCallback(async () => {
    setListing(null);
    const result = await repository.list();
    setListing(result);
    setHydrated(true);
  }, [repository]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (saving || opening) {
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
  }, [route, saving, opening]);
  const saveBrief = async (asNew = false) => {
    setSaving(true);
    setStatus('Saving…');
    const result =
      briefProject && !asNew
        ? await repository.change(briefProject.id, briefProject.revision, {
            kind: 'replace-brief',
            brief,
          })
        : await repository.create({ id: newProjectId(), brief, fit: null });
    setSaving(false);
    if (result.status === 'ok') {
      setBriefProject(result.project);
      setStatus('Saved on this device');
      setSaveFailed(false);
      return true;
    }
    setStatus(failure(result));
    setSaveFailed(true);
    return false;
  };
  const dirty =
    JSON.stringify(brief) !==
    JSON.stringify(briefProject?.brief ?? emptyBrief());
  const guardDraft = (action: () => void) => {
    if (!dirty) {
      action();
      return;
    }
    Alert.alert(
      'Keep your unsaved draft?',
      'Save this draft before opening another brief, or discard these edits.',
      [
        {
          text: 'Keep editing',
          style: 'cancel',
          onPress: () => setRoute('brief'),
        },
        { text: 'Discard edits', style: 'destructive', onPress: action },
      ],
    );
  };
  const updateDrawer = (project: SavedProject) => {
    setDrawer(project);
    // The brief and drawer routes can display the same saved project. Keep its
    // revision and fit current without replacing an unrelated or unsaved brief.
    setBriefProject(current =>
      current?.id === project.id ? project : current,
    );
  };
  const openProject = async (id: string) => {
    setOpening(true);
    setOpenError(null);
    const result = await repository.load(id);
    setOpening(false);
    if (result.status !== 'ok') {
      setOpenError(failure(result));
      await refresh();
      return;
    }
    if (result.project.fit) {
      if (result.project.fit.template === 'drawer-tray') {
        updateDrawer(result.project);
        setRoute('drawer');
        return;
      }
      if (result.project.fit.template !== 'cup-holder-adapter') {
        setOpenError(
          'This measured template cannot be edited in this app yet. Its saved data is unchanged.',
        );
        return;
      }
      setMeasured(result.project);
      setRoute('preview');
    } else {
      guardDraft(() => {
        setBriefProject(result.project);
        setBrief(result.project.brief);
        setStatus('Saved on this device');
        setSaveFailed(false);
        setRoute(briefComplete(result.project.brief) ? 'briefReview' : 'brief');
      });
    }
  };
  const submitPatch = async (patch: FitSpecPatch): Promise<FitSpec> => {
    setSaving(true);
    try {
      const target = measured;
      if (!target) {
        const id = newProjectId();
        // Validate the user's protected patch before any persistent write. This
        // is the initial snapshot, so its saved and fit revisions both start at
        // zero; the temporary seed and its transition are never persisted.
        const initialFit = {
          ...applyFitSpecPatch(seedSpec(), patch),
          id,
          revision: 0,
        };
        const created = await repository.create({
          id,
          brief: {
            object: 'Cup holder & cup',
            context: 'A measured cup-holder example',
            addition: 'An insert to support a cup',
          },
          fit: initialFit,
        });
        if (
          created.status !== 'ok' ||
          created.project.fit?.template !== 'cup-holder-adapter'
        ) {
          throw new Error(failure(created));
        }
        setMeasured(created.project);
        return created.project.fit;
      }
      const result = await repository.change(target.id, target.revision, {
        kind: 'patch-fit',
        patch,
      });
      if (
        result.status === 'ok' &&
        result.project.fit?.template === 'cup-holder-adapter'
      ) {
        setMeasured(result.project);
        return result.project.fit;
      }
      if (result.status === 'stale' || result.status === 'exists') {
        setMeasured(result.latest);
        throw new StaleRevisionError(
          patch.expectedRevision,
          result.latest.fit?.revision ?? 0,
        );
      }
      throw new Error(failure(result));
    } finally {
      setSaving(false);
    }
  };
  let screen: React.ReactNode;
  if (!hydrated || opening) {
    screen = (
      <Screen title="Opening your projects">
        <Text style={type.body}>Loading saved data…</Text>
      </Screen>
    );
  } else
    switch (route) {
      case 'brief':
        screen = (
          <>
            <BriefScreen
              brief={brief}
              onChange={value => {
                setBrief(value);
                setStatus('Unsaved changes');
              }}
              onBack={() => {
                if (!saving) {
                  setRoute('home');
                }
              }}
              onSaveCopy={
                saveFailed
                  ? () => {
                      saveBrief(true);
                    }
                  : undefined
              }
              onSave={() => saveBrief()}
              saveStatus={status}
              saving={saving}
              onReview={async () => {
                if (await saveBrief()) {
                  setRoute('briefReview');
                }
              }}
            />
          </>
        );
        break;
      case 'drawer':
        screen = (
          <DrawerScreen
            onCompanion={() => setCompanionOpen(true)}
            initial={drawer}
            repository={repository}
            onProject={updateDrawer}
            onBack={() => setRoute('home')}
          />
        );
        break;
      case 'briefReview':
        screen = (
          <BriefReviewScreen
            brief={brief}
            onBack={() => setRoute('home')}
            onEdit={() => setRoute('brief')}
            onDrawer={() => {
              setDrawer(briefProject);
              setRoute('drawer');
            }}
            onExample={() => {
              setMeasured(null);
              setRoute('capture');
            }}
          />
        );
        break;
      case 'inspectedFiles':
        screen = captureProjectId ? (
          <InspectedFilesScreen
            id={captureProjectId}
            repository={repository}
            paused={companionOpen}
            onBack={() => {
              refresh();
              setRoute('projects');
            }}
            onCompanion={() => setCompanionOpen(true)}
          />
        ) : null;
        break;
      case 'retainedCaptures':
        screen = captureProjectId ? (
          <RetainedCapturesScreen
            id={captureProjectId}
            repository={repository}
            onBack={() => {
              refresh();
              setRoute('projects');
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
            onMake={() => setRoute('make')}
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
      case 'make':
        screen = scanTarget ? (
          <MakeScreen
            idea={makeIdeas[scanTarget.capture.captureId] ?? null}
            onChange={idea =>
              setMakeIdeas(current => ({
                ...current,
                [scanTarget.capture.captureId]: idea,
              }))
            }
            onBack={() => setRoute('scanResults')}
          />
        ) : null;
        break;
      case 'projects':
        screen = (
          <ProjectsScreen
            result={listing}
            error={openError}
            onOpen={openProject}
            onInspected={id => {
              setCaptureProjectId(id);
              setRoute('inspectedFiles');
            }}
            onCaptures={id => {
              setCaptureProjectId(id);
              setRoute('retainedCaptures');
            }}
            onBack={() => setRoute('home')}
            onRetry={refresh}
          />
        );
        break;
      case 'about':
        screen = (
          <AboutScreen
            onCompanion={() => setCompanionOpen(true)}
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
            onCompanion={() => setCompanionOpen(true)}
            onDrawer={() => {
              setDrawer(null);
              setRoute('drawer');
            }}
            onStartScan={() => {
              setMeasured(null);
              setRoute('capture');
            }}
            brief={
              Object.values(brief).some(value => value.trim()) ? brief : null
            }
            onNewProject={() =>
              guardDraft(() => {
                setBriefProject(null);
                setBrief(emptyBrief());
                setStatus('Not saved yet');
                setSaveFailed(false);
                setRoute('brief');
              })
            }
            onOpenBrief={() =>
              setRoute(briefComplete(brief) && !dirty ? 'briefReview' : 'brief')
            }
            onAbout={() => setRoute('about')}
            onProjects={() => {
              setOpenError(null);
              refresh();
              setRoute('projects');
            }}
          />
        );
    }
  return (
    <SafeAreaProvider>
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
          onRequestClose={() => setCompanionOpen(false)}
        >
          <CompanionScreen onBack={() => setCompanionOpen(false)} />
        </Modal>
      ) : null}
    </SafeAreaProvider>
  );
}
export default App;
