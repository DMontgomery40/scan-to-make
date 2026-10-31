/**
 * OBJ/MTL material references, parsed one way for every companion path: the strict converter check in
 * capture-import and the AI-tweak bundle collector both read lines and names through these helpers.
 */

/** Text lines as the mesh tools read them: Python splitlines() boundaries, trimmed, comments dropped. */
export function* meshTextLines(bytes?:Buffer){
 // Iterate rather than allocating an array containing every line of a large OBJ.
 for(const [raw] of (bytes?.toString('utf8')??'').matchAll(/[^\r\n\v\f\u001c-\u001e\u0085\u2028\u2029]+/g)){
  const line=raw.trim();if(line&&!line.startsWith('#'))yield line;
 }
}

/** `mtllib` names one library: the rest of the line is its filename, spaces included. `''` for a bare `mtllib`. */
export function materialLibrary(line:string):string|undefined{
 const match=/^mtllib(?:\s+(.*))?$/.exec(line);
 return match?match[1]??'':undefined;
}

const TEXTURE_DIRECTIVE=/^(map_\w+|bump|disp|decal|refl|norm)$/i;
const NUMBER=/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;
/** Texture-map options and their argument counts (MTL spec); `-o`, `-s` and `-t` take one to three numbers. */
const OPTION_ARGS:Record<string,[number,number]>={blendu:[1,1],blendv:[1,1],bm:[1,1],boost:[1,1],cc:[1,1],clamp:[1,1],imfchan:[1,1],
 mm:[2,2],o:[1,3],s:[1,3],t:[1,3],texres:[1,1],type:[1,1]};

/**
 * A texture-map line: its options (such as `-clamp off` or `-bm 1.0`) and the filename after them,
 * which may contain spaces. Undefined for other lines, unknown options or a missing filename.
 */
export function textureMap(line:string):{directive:string;options:string[];file:string}|undefined{
 const tokens=[...line.matchAll(/\S+/g)];
 const directive=tokens[0]?.[0];
 if(!directive||!TEXTURE_DIRECTIVE.test(directive))return undefined;
 const options:string[]=[];let index=1;
 while(index<tokens.length&&tokens[index]![0].startsWith('-')){
  const arity=OPTION_ARGS[tokens[index]![0].slice(1).toLowerCase()];
  if(!arity)return undefined;
  options.push(tokens[index++]![0]);
  const [min,max]=arity;let count=0;
  // Leave at least one token for the filename.
  while(count<max&&index<tokens.length-1&&(count<min||NUMBER.test(tokens[index]![0]))){options.push(tokens[index++]![0]);count++;}
  if(count<min)return undefined;
 }
 const start=tokens[index]?.index;
 return start===undefined?undefined:{directive,options,file:line.slice(start).trim()};
}
