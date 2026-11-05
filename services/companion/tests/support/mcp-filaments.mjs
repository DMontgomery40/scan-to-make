// The printer MCP's counterpart_propose_filaments for test runners that fake get_printer_filaments: the real MCP
// proposal (a verbatim fixture copy) over the runner's own inventory, read at call time so a test can swap spools.
import {proposeFilaments} from '../fixtures/mcp-propose-filaments.mjs';

/** The fake inventory as the MCP's proposal trays (bambu-printer-mcp `trays`, or mcp-3D-printer-server `slots`). */
function proposalTrays(inventory) {
  if (Array.isArray(inventory?.slots)) return inventory.slots.flatMap(slot => {
    const number = slot.id === 'ext' ? 254 : Number(slot.id);
    if (!Number.isSafeInteger(number) || !slot.color || !slot.material) return [];
    return [{slot: number, label: slot.label ?? slot.id, name: slot.name ?? slot.material, colour: slot.color.toUpperCase(), material: slot.material,
      filamentId: slot.filamentId ?? '', feed: number >= 254 ? 'external' : 'ams', sliceable: !!slot.profile, ...(slot.profile ? {profile: slot.profile} : {})}];
  });
  return (inventory?.trays ?? []).flatMap(tray => {
    if (tray.loaded !== true || !tray.tray_color || !tray.tray_type) return [];
    return [{slot: tray.slot, label: tray.label ?? (tray.slot >= 254 ? 'External' : `A${tray.slot + 1}`), name: tray.spool_name ?? tray.tray_type,
      colour: `#${tray.tray_color.slice(0, 6).toUpperCase()}`, material: tray.tray_type, filamentId: tray.tray_info_idx ?? '',
      feed: tray.slot >= 254 ? 'external' : 'ams', sliceable: !!tray.resolved_profile_path, ...(tray.resolved_profile_path ? {profile: tray.resolved_profile_path} : {})}];
  });
}

/** Gives a runner with a fake `filaments` the MCP's proposal tool, unless the test fakes that too. */
export function proposingRunner(runner) {
  if (runner.filaments && !runner.proposeFilaments)
    // A method, so a copy of the runner with other spools ({...runner, filaments}) proposes from its own.
    runner.proposeFilaments = async function (input) { return proposeFilaments({...input, trays: proposalTrays(await this.filaments())}); };
  return runner;
}
