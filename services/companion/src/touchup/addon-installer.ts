import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {parseEnv} from 'node:util';
import {basename, dirname, join} from 'node:path';
import type {PrinterHandoffConfig} from '@scan-to-make/printer-handoff';
import {resolveMcpInstall, type InstallEnvironment} from '../printing/mcp-install.js';
import type {AddonInstallation} from './addon-repair.js';

const execute=promisify(execFile);
const INSPECT = `import json
from blender_mcp import addon_manager as a
from importlib.metadata import version, requires
import sys
if sys.argv[1] == "blender-mcp" and not any(r.startswith("mcp-for-blender") for r in requires("blender-mcp") or []):
    raise RuntimeError("The configured package is not the upstream compatibility alias")
print(json.dumps({"version":version("mcp-for-blender"),"protocol":a.EXPECTED_ADDON_PROTOCOL_VERSION,"files":[{"path":str(p.absolute()),"protocol":a.read_addon_protocol_version(p)} for p in a.find_existing_addon_installs()]}))`;
export interface AddonInstallerCommand {command:string; prefix:string[]; env:NodeJS.ProcessEnv; cwd?:string}

/** Resolve the same local install/working directory as MCP Update, including a localhost SSH wrapper. */
export function configuredAddonInstaller(config:PrinterHandoffConfig, host:InstallEnvironment):AddonInstallerCommand {
  const install=resolveMcpInstall(config,host);
  if (basename(config.process.command)==='ssh' && !install.via) throw new Error('Set up the Blender add-on on the Mac running your printer MCP.');
  const cwd=install.via?.cwd ?? config.process.cwd ?? (install.type==='checkout'?install.dir:undefined);
  const text=cwd?host.readFile(join(cwd,'.env')):undefined;
  const file=text?parseEnv(text):{};
  const configured={...file,...(install.via?install.via.env:config.process.env)};
  // The stdio SDK does not inherit host BLENDER_* variables. Do not invent a bridge or addon path from them.
  const inherited=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^BLENDER(?:MCP)?_/.test(key)));
  const env={...inherited,...configured};
  const command=configured.BLENDER_MCP_COMMAND;
  let args:unknown;try{args=JSON.parse(configured.BLENDER_MCP_ARGS??'[]');}catch{}
  if(!command || !Array.isArray(args) || !args.every(a=>typeof a==='string')) throw new Error('The configured printer MCP does not name a Blender installer. Check its Blender setup on your Mac.');
  // Preserve the configured uvx package selection. Other custom bridges retain their own setup instructions.
  if(basename(command)!=='uvx') throw new Error('This Blender bridge uses a custom command. Update its add-on using that bridge’s installer on your Mac.');
  const from=args.indexOf('--from');
  const packageName=from>=0?args[from+1]:args.find(a=>/^(mcp-for-blender|blender-mcp)(?:@|==|$)/.test(a));
  if(typeof packageName!=='string'||!/^(mcp-for-blender|blender-mcp)(?:(?:@|==)[\w.+-]+)?$/.test(packageName)) throw new Error('This Blender bridge uses a custom package. Update its add-on using that bridge’s installer on your Mac.');
  return {command,prefix:['--from',packageName],env,...(cwd?{cwd}:{})};
}

/** Uses upstream inspection and installation; no addon code is downloaded or maintained by Counterpart. */
export class ConfiguredAddonInstaller {
  #selection?:{launch:AddonInstallerCommand;version:string};
  constructor(readonly config:()=>PrinterHandoffConfig,readonly host:InstallEnvironment){}
  async inspect(blenderVersion?:string):Promise<AddonInstallation>{
    const launch=configuredAddonInstaller(this.config(),this.host);
    const {stdout}=await execute(launch.command,[...launch.prefix,'python','-c',INSPECT,launch.prefix[1]!.split(/@|==/)[0]!],{env:launch.env,cwd:launch.cwd,timeout:20_000,maxBuffer:1024*1024});
    let report:{version?:unknown;protocol?:unknown;files?:{path?:unknown;protocol?:unknown}[]};
    try{report=JSON.parse(stdout.trim());}catch{throw new Error('The configured Blender installer did not report its add-on files.');}
    if(typeof report.version!=='string'||!/^\d+\.\d+\.\d+(?:[\w.+-]*)$/.test(report.version)||typeof report.protocol!=='number'||!Number.isInteger(report.protocol)||!Array.isArray(report.files)) throw new Error('The configured Blender installer returned an unsupported report.');
    const selected=selectAddonTarget(report.files,blenderVersion);
    this.#selection={launch,version:report.version};
    return {target:selected.path,protocol:report.protocol,installedProtocol:typeof selected.protocol==='number'?selected.protocol:null};
  }
  async stage(directory:string):Promise<string>{
    if(!this.#selection)throw new Error('Check the configured Blender installer first.');
    const {launch,version}=this.#selection;
    await execute(launch.command,['--from',`mcp-for-blender==${version}`,'mcp-for-blender','install-addon','--addons-dir',directory],{env:launch.env,cwd:launch.cwd,timeout:90_000,maxBuffer:1024*1024});
    return join(directory,'blender_mcp.py');
  }
}

/** Other Blender versions are separate installs, not duplicate enabled modules. */
export function selectAddonTarget(files:{path?:unknown;protocol?:unknown}[],blenderVersion?:string):{path:string;protocol?:unknown} {
  const valid=files.filter((file):file is {path:string;protocol?:unknown}=>typeof file.path==='string');
  const version=blenderVersion?.match(/^\d+\.\d+/)?.[0];
  const candidates=version?valid.filter(file=>file.path.includes(`/Blender/${version}/`)):valid;
  const first=candidates[0];
  if(!first)throw new Error('Install the MCP for Blender add-on for this Blender version on your Mac, then Check Again.');
  const same=candidates.filter(file=>dirname(file.path)===dirname(first.path));
  if(same.length!==1)throw new Error('More than one Blender MCP module is installed in this Blender folder. Keep the enabled module and remove obsolete copies before updating.');
  return first;
}
