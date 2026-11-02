import {lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {dirname, join, sep} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';
import {CaptureBindingSchema} from '@scan-to-make/contracts/capture';
import {ScanProcessingJobSchema, type ScanProcessingJob} from '@scan-to-make/contracts/scan-processing';
import {SavedProjectSync} from '@scan-to-make/project';
import type {HandoffManifest} from '@scan-to-make/printer-handoff';
import type {CaptureServices} from './capture-http.js';
import type {PrintHandoffServices} from './print-handoff-http.js';
import {readBoundedCaptureFile} from './capture-import.js';
import {RemoteAuthStore, RemoteAuthFailure} from './remote-auth.js';
import type {ModelAccessService} from './model-access.js';
import type {NearbyRequest} from '@scan-to-make/contracts/nearby-pairing';
import {InvalidAnswerError, InvalidFileError, InvalidStateError, type ObjectService} from './objects/service.js';
import {CameraUnavailableError} from './printing/camera.js';
import {ObjectNotFoundError} from './objects/store.js';
import {publicObject} from './objects/http.js';
import type {createPrinterCheck} from './printer-check.js';
import {ControlFailure, parameters, type ControlMethod, type DoorParameters, type JobParameters} from './local-control-protocol.js';

interface JobItem {
  kind: 'cleanup' | 'print';
  projectId: string | null;
  projectName: string | null;
  job: ScanProcessingJob | HandoffManifest;
}
export interface ControlServices {
  /** The objects list the Mac app shows (spec §5.6), the same one the phone sees. */
  objects?: ObjectService;
  printerCheck?: ReturnType<typeof createPrinterCheck>;
  modelAccess?: ModelAccessService;
  auth: RemoteAuthStore;
  companionVersion: string;
  capture?: CaptureServices;
  captureDirectory?: string;
  printHandoff?: PrintHandoffServices;
  /** The running server's v2 details (pairing link v2, MAC-5). Without them pairing.create mints v1. */
  pairingLink?: () => {addresses: string[]; publicKeySha256: string; name?: string};
  /** The event log (PRD §8.7). */
  events?: import('./events/log.js').EventLog;
  liveActivityTokens?: import('./devices/live-activity-tokens.js').LiveActivityTokenStore;
  presence?: import('./devices/presence.js').DevicePresence;
  /** Nearby pairing requests waiting for Allow (MAC-5), when the server has nearby pairing on. */
  nearby?: {pending(): NearbyRequest[]; answer(id: string, allow: boolean): Promise<boolean>};
}
const keyOf = (item: JobItem) => `${item.kind}:${item.kind === 'cleanup' ? (item.job as ScanProcessingJob).jobId : (item.job as HandoffManifest).id}`;
async function entries(directory: string) {
  try { return await readdir(directory, {withFileTypes:true}); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
async function contained(root: string, path: string, directory = false) {
  const base = await realpath(root), resolved = await realpath(path);
  const info = await lstat(path);
  if (!resolved.startsWith(base + sep) || (directory ? !info.isDirectory() : !info.isFile())) throw new ControlFailure('unavailable');
  return pathToFileURL(resolved).href;
}

export function createControlDispatcher(services: ControlServices) {
  const {auth,capture,printHandoff} = services;
  const projects = capture ? new SavedProjectSync(capture.storage) : undefined;
  async function captureRows(projectId?: string) {
    if (!projects || !services.captureDirectory) return [];
    const rows = [];
    for (const entry of await entries(services.captureDirectory)) {
      if (!entry.isDirectory() || !z.uuid().safeParse(entry.name).success) continue;
      const folder = join(services.captureDirectory,entry.name);
      const binding = CaptureBindingSchema.parse(JSON.parse((await readBoundedCaptureFile(join(folder,'binding.json'),1024*1024)).toString('utf8')));
      if (projectId !== undefined && binding.projectId !== projectId) continue;
      let project;
      try { project = await projects.get(binding.projectId); }
      catch (error) { if ((error as {code?:string}).code === 'not-found') continue; throw error; }
      // Old revisions retain their bytes, but are not current project work.
      if (project.project.revision !== binding.projectRevision) continue;
      rows.push({folder,captureId:entry.name,binding,project:project.project,mtime:(await lstat(join(folder,'binding.json'))).mtimeMs});
    }
    return rows.sort((a,b) => b.mtime-a.mtime || a.captureId.localeCompare(b.captureId));
  }
  async function jobIndex(params: JobParameters) {
    const items: JobItem[] = [];
    for (const row of await captureRows(params.projectId)) {
      for (const entry of await entries(join(row.folder,'scan-processing'))) {
        if (!entry.isFile() || !entry.name.endsWith('.json') || !z.uuid().safeParse(entry.name.slice(0,-5)).success) continue;
        const job = ScanProcessingJobSchema.parse(JSON.parse((await readBoundedCaptureFile(join(row.folder,'scan-processing',entry.name),65536)).toString('utf8')));
        if (job.captureId !== row.captureId || job.projectId !== row.project.id || job.projectRevision !== row.project.revision || entry.name !== job.jobId+'.json') throw new ControlFailure('unavailable');
        items.push({kind:'cleanup',projectId:job.projectId,projectName:row.project.brief.object,job});
      }
    }
    if (printHandoff && params.projectId === undefined) {
      for (const job of await printHandoff.store.list()) items.push({kind:'print',projectId:null,projectName:null,job});
    }
    items.sort((a,b) => keyOf(a).localeCompare(keyOf(b)));
    // Cursor is bound to the project filter, so it cannot silently skip a different list.
    let after = '';
    if (params.cursor !== undefined) {
      try {
        const cursor = z.strictObject({projectId:z.string().nullable(),after:z.string()}).parse(JSON.parse(Buffer.from(params.cursor,'base64url').toString('utf8')));
        if (cursor.projectId !== (params.projectId ?? null)) throw new Error();
        after = cursor.after;
      } catch { throw new ControlFailure('invalid-request'); }
    }
    const remaining = items.filter(item => keyOf(item).localeCompare(after) > 0);
    const page = remaining.slice(0,params.limit);
    return {items:page,...(remaining.length > page.length ? {nextCursor:Buffer.from(JSON.stringify({projectId:params.projectId ?? null,after:keyOf(page.at(-1)!)})).toString('base64url')} : {})};
  }
  async function prepareDoor(params: DoorParameters) {
    const apps = {blender:'org.blenderfoundation.blender', 'bambu-studio':'com.bambulab.bambu-studio', orca:'com.softfever3d.orca-slicer'};
    if (params.handoffId) {
      if (!printHandoff) throw new ControlFailure('unavailable');
      const manifest = await printHandoff.store.read(params.handoffId);
      const folder = printHandoff.store.directory(manifest.id);
      if (params.door === 'finder') return {action:'reveal',fileURL:pathToFileURL(await realpath(folder)).href,projectRevision:null};
      const suffix = params.door === 'blender' ? '.blend' : '.3mf';
      const artifacts = Object.values(manifest.artifacts).filter(artifact => artifact.file.toLowerCase().endsWith(suffix));
      if (artifacts.length !== 1) throw new ControlFailure('unavailable');
      const artifact = artifacts[0]!;
      const original = join(folder,artifact.file);
      await contained(folder,original);
      const bytes = await readBoundedCaptureFile(original,artifact.byteLength);
      if (bytes.length !== artifact.byteLength || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new ControlFailure('unavailable');
      // Desktop editors may save in place. Never give them the immutable,
      // hash-verified bundle; each open gets its own retained editable copy.
      const copies = join(dirname(auth.directory),'door-copies');
      await mkdir(copies,{recursive:true,mode:0o700});
      const info = await lstat(copies);
      if (!info.isDirectory() || info.uid !== process.getuid!() || (info.mode & 0o077) !== 0) throw new ControlFailure('unavailable');
      const destination = await mkdtemp(join(copies,'open-'));
      const file = join(destination,artifact.file);
      try { await writeFile(file,bytes,{flag:'wx',mode:0o600}); }
      catch (error) { await rm(destination,{recursive:true,force:true}); throw error; }
      return {action:'open',fileURL:pathToFileURL(file).href,applicationBundleId:apps[params.door],projectRevision:null};
    }
    if (!projects) throw new ControlFailure('unavailable');
    await projects.get(params.projectId!); // Distinguish a missing project from one awaiting capture.
    const row = (await captureRows(params.projectId))[0];
    if (!row || params.door !== 'finder') throw new ControlFailure('unavailable');
    return {action:'reveal',fileURL:await contained(services.captureDirectory!,row.folder,true),projectRevision:row.project.revision};
  }
  return async (method: ControlMethod, raw: unknown): Promise<unknown> => {
    if (!parameters[method].safeParse(raw).success) throw new ControlFailure('invalid-request');
    try {
      switch (method) {
        case 'printer.check': {
          if(!services.printerCheck)throw new ControlFailure('unavailable');
          return services.printerCheck.get(parameters[method].parse(raw).start);
        }
        case 'status.get': return {protocolVersion:1,companionVersion:services.companionVersion,transport:auth.transport,
          pairedDeviceCount:(await auth.listDevices()).length,capabilities:{capture:!!capture?.captures,cleanup:!!capture?.scanProcessing,printerHandoff:!!printHandoff,nearbyPairing:!!services.nearby,
            objectsCreate:!!services.objects,printSettings:!!services.objects?.printSettingsAvailable,printControl:!!services.objects?.printSettingsAvailable,
            events:!!services.events&&!!services.liveActivityTokens,structuredPasses:!!services.objects,genericConfirmations:!!services.objects,materialChoice:!!services.objects,projectSettings:!!services.objects}};
        case 'devices.list': {
          const devices = await auth.listDevices();
          const legacy = await auth.legacyDeviceIds?.() ?? new Set<string>();
          return {devices: await Promise.all(devices.map(async device => {
            const seen = await services.presence?.get(device.deviceId) ?? {};
            return {...device, ...(seen.model ? {model: seen.model} : {}), ...(seen.lastSeenAt !== undefined ? {lastSeenAt: seen.lastSeenAt} : {}),
              ...(legacy.has(device.deviceId) ? {legacy: true} : {})};
          }))};
        }
        case 'events.wait': {
          if (!services.events) throw new ControlFailure('unavailable');
          const {after, timeoutMs, limit} = parameters[method].parse(raw);
          return await services.events.wait(after, {waitMs: timeoutMs ?? 25000, ...(limit !== undefined ? {limit} : {})});
        }
        case 'liveActivity.tokens': {
          if (!services.liveActivityTokens) throw new ControlFailure('unavailable');
          return await services.liveActivityTokens.list(new Set((await auth.listDevices()).map(device => device.deviceId)));
        }
        case 'devices.remove': {
          const {deviceId} = parameters[method].parse(raw);
          if (!(await auth.listDevices()).some(device => device.deviceId === deviceId)) throw new ControlFailure('not-found');
          await auth.revoke(deviceId);
          // Its Live Activity tokens and presence go with it.
          await services.liveActivityTokens?.removeDevice(deviceId).catch(() => undefined);
          await services.presence?.forget(deviceId).catch(() => undefined);
          return {removed:true};
        }
        case 'pairing.create': {
          let {login} = parameters[method].parse(raw);
          if (login === undefined) {
            if (auth.transport === 'lan') login = 'lan';
            else {
              const state = JSON.parse((await readBoundedCaptureFile(join(auth.directory,'auth.json'),4*1024*1024)).toString('utf8'));
              login = z.string().parse(state.configuration.allowedLogins[0]);
            }
          }
          if (!auth.allowsLogin(login)) throw new ControlFailure('invalid-request');
          // The invitation JSON keeps its v1 fields; with the server's v2 details the QR is a v2 link.
          return await auth.createPairing(login,undefined,services.pairingLink?.());
        }
        case 'modelAccess.get': {
          if (!services.modelAccess) throw new ControlFailure('unavailable');
          return services.modelAccess.get();
        }
        case 'modelAccess.set': {
          if (!services.modelAccess) throw new ControlFailure('unavailable');
          const {expectedRevision,choice} = parameters[method].parse(raw);
          return await services.modelAccess.set(expectedRevision,choice);
        }
        case 'modelAccess.check': {
          if (!services.modelAccess) throw new ControlFailure('unavailable');
          return services.modelAccess.startCheck(parameters[method].parse(raw).revision);
        }
        case 'pairing.isActive': return {active:await auth.isPairingActive(parameters[method].parse(raw).code)};
        case 'nearby.list': return {items:services.nearby?.pending() ?? []};
        case 'nearby.answer': {
          const {id,allow} = parameters[method].parse(raw);
          if (!services.nearby) throw new ControlFailure('unavailable');
          if (!(await services.nearby.answer(id,allow))) throw new ControlFailure('not-found');
          return {answered:true};
        }
        case 'jobs.list': return await jobIndex(parameters[method].parse(raw));
        case 'confirmations.list': return {items:printHandoff?.relay.pending() ?? []};
        case 'confirmations.answer': {
          const {id,answer} = parameters[method].parse(raw);
          if (!printHandoff?.relay.pending().some(item => item.id === id && item.expiresAtMs > Date.now()) || !printHandoff.relay.respond(id,answer)) throw new ControlFailure('not-found');
          return {answered:true};
        }
        case 'doors.prepare': return await prepareDoor(parameters[method].parse(raw));
        case 'objects.settings.get': case 'objects.settings.set': {
          const objects = services.objects;
          if (!objects) throw new ControlFailure('unavailable');
          try {
            if (method === 'objects.settings.get') return {settings: {status: (await import('./objects/service.js')).projectStatus(await objects.get(parameters[method].parse(raw).id))}};
            const {id, status} = parameters[method].parse(raw);
            const updated = await objects.setStatus(id, status);
            return {settings: {status: (await import('./objects/service.js')).projectStatus(updated)}, object: {...publicObject(updated), directory: objects.dir(updated.id)}};
          } catch (error) {
            if (error instanceof ObjectNotFoundError) throw new ControlFailure('not-found');
            if (error instanceof InvalidStateError) throw new ControlFailure('conflict', error.message);
            throw error;
          }
        }
        case 'objects.list': case 'objects.printers': case 'objects.filaments': case 'objects.selectPrinter': case 'objects.get': case 'objects.passActivity': case 'objects.start': case 'objects.delete': case 'objects.correct': case 'objects.answerCloseup': case 'objects.print': case 'objects.answerPlate': case 'objects.answerPrintConfirmation':
        case 'objects.create': case 'objects.addFile':
        case 'objects.estimate': case 'objects.pausePrint': case 'objects.resumePrint': case 'objects.cancelPrint': case 'objects.camera': case 'printers.camera': case 'settings.get': case 'settings.set': {
          const objects = services.objects;
          if (!objects) throw new ControlFailure('unavailable');
          try {
            // The Mac app is on this Mac: it gets each object's folder to read the renders and model from.
            const local = (o: Awaited<ReturnType<typeof objects.get>>) => ({...publicObject(o), directory: objects.dir(o.id)});
            if (method === 'objects.list') return {objects: (await objects.list()).map(local)};
            if (method === 'objects.printers') return objects.printers({view: true});
            if (method === 'objects.filaments') return {filaments: await objects.filaments(parameters[method].parse(raw).id)};
            if (method === 'objects.passActivity') {
              const {id, index} = parameters[method].parse(raw);
              return {activity: await objects.passActivity(id, index)};
            }
            if (method === 'objects.delete') { await objects.delete((parameters[method].parse(raw) as {id: string}).id); return {deleted: true}; }
            if (method === 'objects.create') {
              const {instructions, kind} = parameters[method].parse(raw);
              return {object: local(await objects.create(instructions, kind))};
            }
            if (method === 'objects.estimate') {
              const {id, ...request} = parameters[method].parse(raw);
              return await objects.estimate(id, request);
            }
            if (method === 'objects.pausePrint' || method === 'objects.resumePrint' || method === 'objects.cancelPrint') {
              const action = method === 'objects.pausePrint' ? 'pause' : method === 'objects.resumePrint' ? 'resume' : 'cancel';
              return {object: local(await objects.control(parameters[method].parse(raw).id, action))};
            }
            if (method === 'objects.camera' || method === 'printers.camera') {
              try {
                const frame = method === 'objects.camera' ? await objects.camera(parameters[method].parse(raw).id) : await objects.printerCamera(parameters[method].parse(raw).destinationId);
                return {format: 'jpeg', base64: frame.bytes.toString('base64'), capturedAt: frame.capturedAt};
              } catch (error) {
                if (error instanceof CameraUnavailableError) throw new ControlFailure(error.reason === 'no-camera' ? 'not-found' : 'unavailable', error.message);
                throw error;
              }
            }
            if (method === 'settings.get') return {settings: await objects.settings()};
            if (method === 'settings.set') return {settings: await objects.updateSettings(parameters[method].parse(raw))};
            if (method === 'objects.addFile') {
              const {id, kind, path} = parameters[method].parse(raw);
              return {object: local(await objects.addFile(id, kind, path))};
            }
            if (method === 'objects.correct') {
              const {id, note, photos} = parameters[method].parse(raw);
              return {object: local(await objects.correct(id, note, photos))};
            }
            if (method === 'objects.answerPrintConfirmation') {
              const {id, confirmationId, answer} = parameters[method].parse(raw);
              return {object: local(await objects.answerPrintConfirmation(id, confirmationId, answer))};
            }
            const params = parameters[method].parse(raw) as {id: string; destinationId?: string; note?: string; bestGuess?: boolean} & import('./objects/service.js').PrintOptions;
            const object = method === 'objects.get' ? await objects.view(params.id)
              : method === 'objects.selectPrinter' ? await objects.selectPrinter(params.id, params.destinationId!)
              : method === 'objects.start' ? await objects.start(params.id)
              : method === 'objects.answerCloseup' ? await objects.answerCloseup(params.id, {bestGuess: params.bestGuess!, ...((params as {text?: string}).text ? {text: (params as {text?: string}).text} : {})})
              : method === 'objects.print' ? await objects.print(params.id, (({id: _id, ...options}) => options)(params))
              : await objects.answerPlate(params.id, {clear: true});
            return {object: local(object)};
          } catch (error) {
            if (error instanceof ObjectNotFoundError) throw new ControlFailure('not-found');
            // Its sentence is written for the person ("There is no model to print yet.").
            // A refused answer says which field and why.
            if (error instanceof InvalidAnswerError) throw new ControlFailure('invalid-request', error.message);
            if (error instanceof InvalidStateError || error instanceof InvalidFileError) throw new ControlFailure('conflict', error.message);
            throw error;
          }
        }
      }
    } catch (error) {
      if (error instanceof ControlFailure) throw error;
      // Request schemas were checked above. A schema failure here belongs to
      // persisted/service data, not to the caller's valid request.
      if (error instanceof z.ZodError) throw new ControlFailure('unavailable');
      if (error instanceof RemoteAuthFailure) throw new ControlFailure(error.code === 'rate-limited' ? 'conflict' : 'unavailable');
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as {code?:string}).code === 'not-found') throw new ControlFailure('not-found');
      if ((error as {code?:string}).code === 'precondition-failed') throw new ControlFailure('conflict');
      throw new ControlFailure('unavailable');
    }
  };
}

export async function companionVersion() {
  return z.object({version:z.string()}).parse(JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'))).version;
}
