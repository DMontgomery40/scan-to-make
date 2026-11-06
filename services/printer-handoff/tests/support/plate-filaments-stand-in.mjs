// A stand-in for the MCPs' per-plate filaments (list_3mf_plates `filaments` and `project_filaments`,
// bambu-printer-mcp 1.1.73 / mcp-3d-printer-server 1.2.53), for test MCPs only: Counterpart itself reads no project
// filament metadata (PRD §8.0). It answers the common case the way the MCPs do: each part's filament (else its
// object's, else 1) for the objects on the plate, or a sliced plate's own plate_N.json filament_ids.
import {unzipSync} from 'fflate';

const describe = (index, project) => {
  const colour = /^#?([0-9a-fA-F]{6})/.exec(String(project.filament_colour?.[index - 1] ?? ''));
  const material = project.filament_type?.[index - 1];
  return {index, ...(colour ? {colour: `#${colour[1].toUpperCase()}`} : {}), ...(material ? {material: String(material)} : {})};
};

export function standInFilaments(bytes) {
  let files = {};
  try { files = unzipSync(bytes, {filter: file => /^Metadata\/(model_settings\.config|project_settings\.config|plate_\d+\.json)$/.test(file.name)}); } catch { return {plates: new Map(), project: []}; }
  const text = name => files[name] ? Buffer.from(files[name]).toString('utf8') : '';
  let project = {};
  try { project = JSON.parse(text('Metadata/project_settings.config') || '{}'); } catch { /* none */ }
  const settings = text('Metadata/model_settings.config');
  const objects = new Map([...settings.matchAll(/<object\b[^>]*\bid="(\d+)"[^>]*>([\s\S]*?)<\/object>/g)].map(match => {
    const shell = match[2].replace(/<part\b[^>]*>[\s\S]*?<\/part>/g, '');
    const objectExtruder = Number(/key="extruder"\s+value="(\d+)"/.exec(shell)?.[1] ?? 1) || 1;
    const name = /key="name"\s+value="([^"]*)"/.exec(shell)?.[1];
    const parts = [...match[2].matchAll(/<part\b([^>]*)>([\s\S]*?)<\/part>/g)]
      .filter(part => !/subtype="(negative_part|support_blocker|support_enforcer)"/.test(part[1]))
      .map(part => ({extruder: Number(/key="extruder"\s+value="(\d+)"/.exec(part[2])?.[1] ?? 0) || objectExtruder, name: /key="name"\s+value="([^"]*)"/.exec(part[2])?.[1] || name}));
    return [match[1], parts.length ? parts : [{extruder: objectExtruder, name}]];
  }));
  const plates = new Map();
  const plateBlocks = [...settings.matchAll(/<plate>([\s\S]*?)<\/plate>/g)];
  const layouts = plateBlocks.length
    ? plateBlocks.map(block => [Number(/key="plater_id"\s+value="(\d+)"/.exec(block[1])?.[1]), [...block[1].matchAll(/key="object_id"\s+value="(\d+)"/g)].map(m => m[1])])
    : [[1, [...objects.keys()]]];
  for (const name of Object.keys(files)) {
    const number = Number(/^Metadata\/plate_(\d+)\.json$/.exec(name)?.[1]);
    if (number && !layouts.some(([n]) => n === number)) layouts.push([number, []]);
  }
  for (const [number, ids] of layouts) {
    const used = new Map();
    for (const id of ids) for (const part of objects.get(id) ?? []) if (!used.has(part.extruder)) used.set(part.extruder, part.name);
    let sliced;
    try { sliced = JSON.parse(text(`Metadata/plate_${number}.json`) || 'null')?.filament_ids; } catch { /* none */ }
    if (Array.isArray(sliced) && sliced.length) { const names = new Map(used); used.clear(); for (const id of sliced) used.set(id + 1, names.get(id + 1)); }
    if (!used.size) used.set(1, undefined);
    plates.set(number, [...used].sort((a, b) => a[0] - b[0]).map(([index, name]) => ({...describe(index, project), ...(name ? {name} : {})})));
  }
  const declared = Math.max(project.filament_colour?.length ?? 0, project.filament_type?.length ?? 0);
  return {plates, project: Array.from({length: declared}, (_, i) => describe(i + 1, project))};
}
