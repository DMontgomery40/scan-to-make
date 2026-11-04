import {readFileSync} from 'node:fs';

/**
 * David's FDM design prompt pack (2026-11-03; developer notes in docs/design/fdm-prompt-pack).
 * The prompts ship verbatim in prompts/fdm and are inlined into the system rules: a
 * Codex worker has no file tools and an API worker reads only its pass folder.
 */
export type FdmGuidance = '01_core' | '02_multicolor' | '03_assembly' | '04_after_slice' | 'capability-guidance';

const cache = new Map<FdmGuidance, string>();

export function fdmGuidance(name: FdmGuidance): string {
  let text = cache.get(name);
  if (text === undefined) {
    const file = name === 'capability-guidance' ? `${name}.md` : `${name}.txt`;
    text = readFileSync(new URL(`../../prompts/fdm/${file}`, import.meta.url), 'utf8').trim();
    cache.set(name, text);
  }
  return text;
}
