export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Plate {
  id: string;
  fileIndex: number;
  plateIndex: number;
  name: string;
  fileName: string;
  thumbnail?: string;
  selected: boolean;
  sliced: boolean;
  status: string;
  /** Its last send may have reached the printer: printing it again asks "I checked the printer". */
  uncertain?: boolean;
}
export interface Field {
  name: string;
  title: string;
  description?: string;
  required: boolean;
  type?: string;
  enum?: string[];
  enumNames?: string[];
  default?: string | number | boolean;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  format?: string;
  items?: { type: string; enum?: string[] };
}
export interface Question {
  id: string;
  message: string;
  expiresAtMs: number;
  fields: Field[];
  supported: boolean;
  url?: string;
  mode?: string;
}
export interface RawQuestion {
  id: string;
  message: string;
  expiresAtMs: number;
  fields?: Field[];
  supported?: boolean;
  mode?: string;
  url?: string;
  requestedSchema?: unknown;
}
/** One size a question asks about, in millimetres. `id` is opaque; `label` says what to measure. */
export interface AskSize {
  id: string;
  label: string;
  mm: number;
  from: "scan" | "published" | string;
}
export interface Ask {
  id: string;
  question: string;
  /** closeup, file, choice, region, scale, sizes: what the project is waiting on the person for. */
  kind?: string;
  /** `sizes`: the sizes to confirm or correct, prefilled. */
  sizes?: AskSize[];
  photo?: string;
  region?: { x: number; y: number; width: number; height: number };
  answers: string[];
  type?: string;
  url?: string;
  options?: {
    id: string;
    label: string;
    detail?: string;
    thumbnail?: string;
  }[];
  multiple?: boolean;
  status: string;
}
export type Vec3 = [number, number, number];
export interface ReconstructionComponent {
  index: number;
  vertices: number;
  faces: number;
  share: number;
  boundsMin: Vec3;
  boundsMax: Vec3;
  extents: { x: number; y: number; z: number };
}
export interface ReconstructionReview {
  id: string;
  kind: "region" | "scale";
  preview: string;
  previewMeshSha256?: string;
  meshSha256?: string;
  boundsMin: Vec3;
  boundsMax: Vec3;
  extents: { x: number; y: number; z: number };
  scaleKnown: boolean;
  scaleMPerUnit?: number;
  suggestion?: {
    type: "anchor-region" | "component";
    reason: string;
    extents: { x: number; y: number; z: number };
    extentsM?: { x: number; y: number; z: number };
  };
  components?: ReconstructionComponent[];
}
export type ReconstructionSelection =
  | { type: "suggested" }
  | { type: "component"; index: number }
  | { type: "crop"; min: Vec3; max: Vec3 };
export type ReconstructionAnswer =
  | {
      type: "region";
      previewMeshSha256: string;
      selection: ReconstructionSelection;
    }
  | {
      type: "scale";
      meshSha256: string;
      axis: "x" | "y" | "z";
      extentMm: number;
    };
export interface Pass {
  startedAtMs: number;
  endedAtMs?: number;
  note?: string;
  /** Why the pass started; a note is the person's own words only for `changes` and `late-photos`. */
  trigger?: string;
  photos?: string[];
  summary?: string;
  status?: string;
  /** How it ended, in the companion's words; absent while it runs. */
  words?: string;
  activityCount?: number;
  stages?: { id: string; words: string; endedAtMs?: number }[];
}
export interface PrintOptions {
  quality?: string;
  strength?: string;
  copies?: number;
  pauseBeforeLayers?: number[];
  colour?: {
    auto?: boolean;
    amsSlot?: number;
    external?: boolean;
    material?: string;
  };
}
export interface Project {
  id: string;
  title: string;
  instructions?: string;
  directory?: string;
  createdAtMs: number;
  updatedAtMs: number;
  state: string;
  kind?: string;
  archived?: boolean;
  /** "works" or "needs-changes" from a companion that keeps the answer here rather than in `settings.status`. */
  outcome?: string;
  progress?: string;
  failure?: string;
  /** The stopped pass can be started again from where it left off. */
  canRetryCleanup?: boolean;
  pendingFollowup?: string;
  photos: string[];
  capture?: string[];
  requestPhotos?: string[];
  messages?: { id: string; text: string; atMs: number; photos: string[] }[];
  passes: Pass[];
  completion?: { note: string; atMs: number; undone?: boolean };
  current?: {
    model: string;
    renders: string[];
    sizeMm?: number[];
    summary?: string;
    changes?: { tag: string; text: string }[];
    /** This 3MF prints with the settings it carries (a designer's project), as its printer's MCP says. */
    ownSettings?: boolean;
    /** A fit's places for the scanned object (docs/protocols/seats.md). */
    seats?: { name?: string; translationMm: number[]; rotationDeg: number[] }[];
  };
  scan?: string;
  /** The project whose scan this one was made from, with its title then ("Make something else from this scan"). */
  scanFrom?: { id: string; title: string };
  /** The project's picture (PRD §5.1): the object alone on the stage, drawn by the computer. */
  picture?: string;
  pictures?: { part?: string; scan?: string; together?: string; photo?: string };
  /** A picture the computer has not drawn, by role: drawing now, or failed (none is coming until what it shows changes). */
  pictureStates?: { part?: "drawing" | "failed"; scan?: "drawing" | "failed"; together?: "drawing" | "failed"; photo?: "drawing" | "failed" };
  files?: { original: string[] };
  plates?: Plate[];
  ask?: Ask;
  reconstructionReview?: ReconstructionReview;
  question?: { closeup: string };
  /** `detail`: what a list row shows under its phase's heading, never the heading again. */
  status?: { text: string; phase: string; tint: string; detail?: string };
  printerDestinationId?: string;
  settings?: {
    status: string;
    archived: boolean;
    designEngine?: string;
    notifications?: string;
    printDefaults?: PrintOptions;
  };
  preferences?: { printDefaults?: PrintOptions };
  credit?: {
    url: string;
    designer?: string;
    site?: string;
    title?: string;
    licence?: string;
    thumbnail?: string;
  };
  printConfirmation?: RawQuestion;
  print?: {
    uncertain?: boolean;
    /** Set once the file was sent to the printer. */
    dispatchedAt?: string;
    destinationId?: string;
    destination?: { id: string; name: string };
    settings?: PrintOptions;
    monitor?: { phase: string; endState?: string; unreachableSince?: string };
    live?: {
      observedAt: string;
      state: string;
      job?: {
        progress?: number;
        layer?: number;
        totalLayers?: number;
        remainingSec?: number;
        stage?: string;
      };
      problems: { code: string; message: string }[];
      activeFilament?: { slot?: string; material?: string; color?: string };
    };
    events?: { atMs: number; message: string }[];
    /** The spools this print uses (PRD §5.4). */
    spools?: { index?: number; colour: string; material?: string; name?: string }[];
  };
}
export interface Printer {
  id: string;
  name: string;
  backend: string;
  model?: string;
  address?: string;
  state?: string;
  origin?: string;
  folder?: string;
  mcpId?: string;
  capabilities?: Record<string, unknown>;
  mcps?: { backend: string; destinationId: string }[];
  /** Other catalog ids that now stand for this same printer, as the Mac resolves them. Absent on older Macs. */
  aliases?: string[];
  incomplete?: { missing: string[]; fill: Record<string, string> };
}
export interface Filament {
  slot: number;
  colour: string;
  material: string;
  name: string;
  filamentId: string;
  destinationId: string;
  /** Where the spool sits, in the printer MCP's own words. */
  label?: string;
  /** Which spools can feed one print together, as the printer MCP groups them. */
  feed?: string;
  suggested?: boolean;
}
/** `objects.colourMapping`: a multi-colour model's parts, and the spool the printer MCP proposes for each. */
export interface ColourMapping {
  filaments: {
    index: number;
    name?: string;
    colour?: string;
    material?: string;
    /** The MCP's proposed spool; absent when nothing can print this colour. */
    slot?: number;
    verdict?: string;
    /** What the person should know about the proposal, in the MCP's words. */
    note?: string;
  }[];
  trays: Filament[];
  modelVersion?: string;
}
export interface Estimate {
  destinationId: string;
  quality: string;
  strength: string;
  seconds?: number;
  grams?: number;
  layers?: number;
  warnings?: string[];
  copies?: number;
  /** The sliced file this estimate made; Print sends it as `sliceSha256` (packages/contracts PrintEstimateSchema). */
  sliceSha256?: string;
  /** The printer MCP's pictures of that exact file's G-code. Absent when the installed MCP can't draw them. */
  preview?: {
    sha256: string;
    views: {
      name: string;
      label: string;
      png: string;
      width: number;
      height: number;
    }[];
    mmPerPixel?: number;
  };
  /** The installed printer MCP can't say whether this 3MF prints with its own settings: update it. */
  ownSettingsUpdate?: string;
}
export interface HostStatus {
  configured: boolean;
  running: boolean;
  stateDir: string;
  controlSocket: string;
}
export type ModelChoice =
  | { kind: "none" | "claude-code" | "codex-cli" }
  | {
      kind: "api";
      provider: "anthropic" | "openai";
      model: string;
      keychainRef: string;
    }
  | { kind: "endpoint"; url: string; model: string; keychainRef?: string };
export interface ModelRecord {
  revision: string;
  choice: ModelChoice;
  check?: { revision: string; state: string; outcome?: string };
}
export interface CompanionSettings {
  milestones: string;
  general?: Record<string, boolean>;
  notifications?: { mac?: Record<string, boolean> };
}
export interface SetupOptions {
  types: {
    printerType: string;
    label: string;
    backends: string[];
    serial: boolean;
    secret?: {
      label: string;
      hint?: string;
      required: boolean;
      /** The MCPs that can fetch it for the person (`printers.obtain`), and the button's words, in the MCP's own words. */
      obtain?: { label: string; hint?: string; backends: string[] };
    };
    /** The address field in the MCP's words; `url` when it also takes a web address (https://…, a sub-path). */
    address?: { hint?: string; url?: boolean };
    /** Every setting the MCP reads for this kind, in its words (`counterpart_setup_fields`), by form role in `name`. */
    fields?: SetupField[];
  }[];
  models: Record<string, { value: string; label: string }[]>;
  serialModels?: Record<string, string>;
  /** The slicer each MCP would run and the settings that choose it, in the MCP's words (`counterpart_setup_fields`). */
  slicer?: Record<string, SlicerSetup>;
  /** MCPs that need an update before they can set up printers. */
  updates?: { package: string; message: string }[];
}
export interface SetupField {
  name: string;
  env: string;
  label: string;
  hint?: string;
  required: boolean;
  input?: string;
  choices?: { value: string; label: string }[];
}
export interface SlicerSetup {
  type: string;
  path?: string;
  found: boolean;
  profilesRoot?: string;
  profilesFound?: boolean;
  fields: SetupField[];
}
export interface McpPackage {
  appCopy?: { kind: string; path?: string; version?: string };
  uses?: {
    destinationId: string;
    printer: string;
    mcpId: string;
    kind: string;
    path?: string;
    version?: string;
    canMove: boolean;
    /** Runs Counterpart's own copy (absent from a companion before Nov 6). */
    managed?: boolean;
    /** The companion's sentence: which copy, its version, and whether it's older than Counterpart's. */
    words?: string;
  }[];
  /** The Moves in the order the uses are listed, each titled by its printers, MCP and copy (Nov 6). */
  moves?: { mcpId: string; title: string }[];
  package: string;
  label: string;
  description: string;
  installed: boolean;
  version?: string;
  latestVersion?: string;
  appMcpId: string;
  installs: {
    mcpId: string;
    version?: string;
    source?: string;
    path?: string;
  }[];
}
export interface Route {
  route: string;
  choices: string[];
  options?: {
    id?: string;
    value?: string;
    label?: string;
    route?: string;
    available?: boolean;
    reason?: string;
  }[];
}

/** `printers.obtain`: one step of fetching a form field through its MCP (OctoPrint's key, approved in OctoPrint). */
export interface ObtainStep {
  session?: string;
  status: "pending" | "approved" | "failed";
  message: string;
  approveUrl?: string;
  value?: string;
}
