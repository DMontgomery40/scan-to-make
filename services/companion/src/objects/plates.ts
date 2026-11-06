import type {StmObject} from './store.js';

export interface PlateIdentity {sha256: string; plateIndex: number}
export interface PlateProgress {
  status: 'not-printed' | 'preparing' | 'printing' | 'paused' | 'printed' | 'cancelled' | 'failed' | 'sent' | 'unknown';
  printId?: string;
  completedAtMs?: number;
  acknowledgedAtMs?: number;
}
export interface ProjectPlate extends PlateProgress {
  id: string; fileIndex: number; plateIndex: number; name: string; fileName: string;
  thumbnail?: string; selected: boolean; sliced: boolean;
}
const key = (plate: PlateIdentity) => `${plate.sha256}:${plate.plateIndex}`;
export function selectedPlateIdentity(object: StmObject): PlateIdentity | undefined {
  const selected = object.publishedSelection;
  const file = selected && object.files?.receipts?.[selected.fileIndex];
  return file && selected ? {sha256: file.sha256, plateIndex: selected.plateIndex} : undefined;
}

/** Save one result per original-file hash + plate, never one per attempt. The in-flight print owns its identity. */
export function retainedPlateProgress(object: StmObject): Record<string, PlateProgress> {
  const saved = {...object.plateProgress};
  const print = object.print;
  // Older builds did not freeze a plate on the print; their selection could not change during printing.
  const plate = print?.plate ?? selectedPlateIdentity(object);
  if (!print || !plate) return saved;
  const previous = saved[key(plate)];
  if (previous?.acknowledgedAtMs !== undefined && previous.printId === print.printId) return saved;
  const end = print.monitor?.endState;
  const active = object.state === 'printing';
  const status: PlateProgress['status'] = end === 'done' ? 'printed'
    : end === 'cancelled' ? 'cancelled'
    : end === 'failed' || end === 'not-started' || end === 'replaced' ? 'failed'
    : end === 'sent' || object.state === 'sent' ? 'sent'
    : active ? (print.live?.state === 'paused' ? 'paused' : print.live?.state === 'printing' ? 'printing' : 'preparing')
    // A start Counterpart couldn't confirm (such as a timed-out printer report) is unknown, never "failed": it may be printing.
    : print.uncertain ? 'unknown'
    : object.state === 'failed' ? 'failed' : 'unknown';
  const ended = print.monitor?.endedAt ? Date.parse(print.monitor.endedAt) : object.updatedAtMs;
  const completedAtMs = previous?.completedAtMs ?? (status === 'printed' ? (Number.isFinite(ended) ? ended : object.updatedAtMs) : undefined);
  saved[key(plate)] = {status, ...(print.printId ? {printId: print.printId} : {}), ...(completedAtMs !== undefined ? {completedAtMs} : {})};
  return saved;
}

export function projectPlates(object: StmObject): ProjectPlate[] {
  if (object.kind !== 'published') return [];
  const progress = retainedPlateProgress(object);
  const rows = (object.files?.receipts ?? []).flatMap((file, fileIndex) =>
    (file.plates.length ? file.plates : [{index: 0, name: 'Model', sliced: false, thumbnail: undefined}]).map(plate => ({
      id: `${file.sha256}:${plate.index}`, fileIndex, plateIndex: plate.index, name: plate.name, fileName: file.name,
      ...(plate.thumbnail ? {thumbnail: plate.thumbnail} : {}), sliced: plate.sliced,
      selected: object.publishedSelection?.fileIndex === fileIndex && object.publishedSelection.plateIndex === plate.index,
      status: 'not-printed' as const, ...progress[`${file.sha256}:${plate.index}`],
    })));
  // Older projects can retain the same original bytes under multiple download names.
  const unique = new Map<string, ProjectPlate>();
  for (const row of rows) if (!unique.has(row.id) || row.selected) unique.set(row.id, row);
  return [...unique.values()];
}

/** An explicit user acknowledgement, including a part printed outside Counterpart. */
export function acknowledgePlate(object: StmObject, status: 'printed' | 'not-printed'): Record<string, PlateProgress> {
  const saved = retainedPlateProgress(object), plate = selectedPlateIdentity(object);
  if (!plate) return saved;
  const now = Date.now();
  saved[key(plate)] = {status, acknowledgedAtMs: now,
    ...(object.print?.printId ? {printId: object.print.printId} : {}),
    ...(status === 'printed' ? {completedAtMs: saved[key(plate)]?.completedAtMs ?? now} : {})};
  return saved;
}

/** A plate whose last send may have reached the printer: printing it again needs the person to check the printer first. */
export function plateNeedsPrinterCheck(object: StmObject): boolean {
  if (object.print?.uncertain) return true;
  const status = projectPlates(object).find(plate => plate.selected)?.status;
  return status === 'unknown' || status === 'sent';
}

export function selectingPlate(object: StmObject, fileIndex: number, plateIndex: number): StmObject {
  const plate = projectPlates(object).find(item => item.fileIndex === fileIndex && item.plateIndex === plateIndex);
  const file = object.files?.receipts?.[fileIndex];
  if (!plate || !file || !object.current) throw new Error('Choose a plate in this model.');
  // Selecting the current plate is a no-op unless it is the initial unanswered plate question.
  if (plate.selected && object.ask?.status !== 'open') return object;
  return {...object, state: 'ready', plateProgress: retainedPlateProgress(object),
    print: undefined, printConfirmation: undefined, failure: undefined, progress: undefined,
    outcome: undefined, completion: undefined,
    // Another file: whether it carries its own settings is asked again (ownSettings). Another plate of the same file keeps it.
    current: {...object.current, model: file.path, renders: plate.thumbnail ? [plate.thumbnail] : [],
      ...(file.path !== object.current.model ? {ownSettings: undefined, ownSettingsFor: undefined} : {})},
    ...(file.credit ? {credit: file.credit} : {}), files: {...object.files!, current: file.path},
    publishedSelection: {fileIndex, plateIndex, sliced: plate.sliced},
    ...(object.ask?.type === 'choice' && object.ask.status === 'open' ? {ask: {...object.ask, status: 'answered', choices: [`${fileIndex}:${plateIndex}`]}} : {}),
  };
}
