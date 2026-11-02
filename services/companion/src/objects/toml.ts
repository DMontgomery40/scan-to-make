/**
 * A strict reader for the TOML that Codex's `~/.codex/config.toml` uses:
 * tables and array tables with bare, quoted and dotted keys; basic, literal
 * and multi-line strings; integers, floats, booleans and dates; arrays and
 * inline tables. Anything else is a syntax error, and the caller ignores the
 * whole file. (A TOML package would need the Mac app's third-party notices
 * regenerated, which belongs to the apps/ owners.)
 */
export class TomlError extends Error {
  constructor(message: string, readonly offset: number) { super(`${message} at ${offset}`); this.name = 'TomlError'; }
}

type Table = Record<string, unknown>;
const BARE = /[A-Za-z0-9_-]/;

export function parseToml(source: string): Table {
  let i = 0;
  const root: Table = {};
  let current: Table = root;
  const fail = (message: string): never => { throw new TomlError(message, i); };
  const peek = (offset = 0) => source[i + offset];
  const startsWith = (text: string) => source.startsWith(text, i);
  const skipSpaces = () => { while (peek() === ' ' || peek() === '\t') i++; };
  const skipComment = () => { if (peek() === '#') while (i < source.length && peek() !== '\n') i++; };
  const skipBlank = () => { // whitespace, newlines and comments (inside arrays)
    for (;;) {
      skipSpaces(); skipComment();
      if (peek() === '\r' && peek(1) === '\n') i += 2;
      else if (peek() === '\n') i++;
      else return;
    }
  };
  const endOfLine = () => {
    skipSpaces(); skipComment();
    if (i >= source.length) return;
    if (peek() === '\r' && peek(1) === '\n') { i += 2; return; }
    if (peek() === '\n') { i++; return; }
    fail('Expected the end of the line');
  };

  function escape(): string {
    const c = source[i++];
    switch (c) {
      case 'b': return '\b'; case 't': return '\t'; case 'n': return '\n'; case 'f': return '\f'; case 'r': return '\r';
      case 'e': return '\u001b'; case '"': return '"'; case '\\': return '\\';
      case 'u': case 'U': {
        const length = c === 'u' ? 4 : 8, hex = source.slice(i, i + length);
        if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== length) fail('Invalid unicode escape');
        i += length;
        const point = parseInt(hex, 16);
        if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) fail('Invalid unicode escape');
        return String.fromCodePoint(point);
      }
      default: return fail('Invalid escape');
    }
  }
  function basicString(): string {
    if (startsWith('"""')) {
      i += 3;
      if (peek() === '\n') i++; else if (startsWith('\r\n')) i += 2;
      let out = '';
      for (;;) {
        if (i >= source.length) fail('Unterminated string');
        if (startsWith('"""')) {
          i += 3;
          for (let extra = 0; extra < 2 && peek() === '"'; extra++) { out += '"'; i++; } // up to two closing quotes belong to the content
          return out;
        }
        if (peek() === '\\') {
          i++;
          if (/[ \t\r\n]/.test(peek() ?? '')) { // line-ending backslash
            while (/[ \t\r\n]/.test(peek() ?? '')) i++;
            continue;
          }
          out += escape();
        } else out += source[i++];
      }
    }
    i++;
    let out = '';
    for (;;) {
      const c = peek();
      if (c === undefined || c === '\n') fail('Unterminated string');
      if (c === '"') { i++; return out; }
      if (c === '\\') { i++; out += escape(); } else { out += c; i++; }
    }
  }
  function literalString(): string {
    if (startsWith("'''")) {
      i += 3;
      if (peek() === '\n') i++; else if (startsWith('\r\n')) i += 2;
      const end = source.indexOf("'''", i);
      if (end < 0) fail('Unterminated string');
      let stop = end;
      while (source[stop + 3] === "'" && stop < end + 2) stop++;
      const out = source.slice(i, stop);
      i = stop + 3;
      return out;
    }
    i++;
    const end = source.indexOf("'", i), newline = source.indexOf('\n', i);
    if (end < 0 || (newline >= 0 && newline < end)) fail('Unterminated string');
    const out = source.slice(i, end);
    i = end + 1;
    return out;
  }
  function key(): string[] {
    const parts: string[] = [];
    for (;;) {
      skipSpaces();
      if (peek() === '"') { if (startsWith('"""')) fail('Invalid key'); parts.push(basicString()); }
      else if (peek() === "'") { if (startsWith("'''")) fail('Invalid key'); parts.push(literalString()); }
      else {
        const start = i;
        while (i < source.length && BARE.test(peek()!)) i++;
        if (i === start) fail('Expected a key');
        parts.push(source.slice(start, i));
      }
      skipSpaces();
      if (peek() !== '.') return parts;
      i++;
    }
  }
  function value(): unknown {
    const c = peek();
    if (c === '"') return basicString();
    if (c === "'") return literalString();
    if (c === '[') {
      i++;
      const items: unknown[] = [];
      for (;;) {
        skipBlank();
        if (peek() === ']') { i++; return items; }
        items.push(value());
        skipBlank();
        if (peek() === ',') { i++; continue; }
        if (peek() === ']') { i++; return items; }
        fail('Expected , or ] in an array');
      }
    }
    if (c === '{') {
      i++;
      const table: Table = {};
      skipSpaces();
      if (peek() === '}') { i++; return table; }
      for (;;) {
        const path = key();
        if (peek() !== '=') fail('Expected =');
        i++; skipSpaces();
        assign(table, path, value());
        skipSpaces();
        if (peek() === ',') { i++; continue; }
        if (peek() === '}') { i++; return table; }
        fail('Expected , or } in an inline table');
      }
    }
    if (startsWith('true') && !BARE.test(source[i + 4] ?? '')) { i += 4; return true; }
    if (startsWith('false') && !BARE.test(source[i + 5] ?? '')) { i += 5; return false; }
    const start = i;
    while (i < source.length && /[0-9A-Za-z_+\-.:]/.test(peek()!)) i++;
    // A date-time may have one space between its date and time.
    if (peek() === ' ' && /^\d{4}-\d{2}-\d{2}$/.test(source.slice(start, i)) && /\d/.test(source[i + 1] ?? '')) {
      i++;
      while (i < source.length && /[0-9:.+\-Z]/.test(peek()!)) i++;
    }
    const token = source.slice(start, i);
    if (!token) fail('Expected a value');
    if (/^[+-]?(0|[1-9](_?\d)*)$/.test(token)) return Number(token.replace(/_/g, ''));
    if (/^0x[0-9A-Fa-f](_?[0-9A-Fa-f])*$|^0o[0-7](_?[0-7])*$|^0b[01](_?[01])*$/.test(token)) return Number(token.replace(/_/g, ''));
    if (/^[+-]?(0|[1-9](_?\d)*)(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?$/.test(token)) return Number(token.replace(/_/g, ''));
    if (/^[+-]?(inf|nan)$/.test(token)) return token.endsWith('inf') ? (token.startsWith('-') ? -Infinity : Infinity) : NaN;
    if (/^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})?)?$|^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(token)) return token;
    return fail('Invalid value');
  }
  function assign(table: Table, path: string[], item: unknown) {
    let target = table;
    for (const part of path.slice(0, -1)) {
      const next = Object.hasOwn(target, part) ? target[part] : (target[part] = {});
      if (!next || typeof next !== 'object' || Array.isArray(next)) fail('Key redefined');
      target = next as Table;
    }
    const last = path.at(-1)!;
    if (Object.hasOwn(target, last)) fail('Key redefined');
    target[last] = item;
  }
  function table(path: string[], array: boolean): Table {
    let target = root;
    for (const [index, part] of path.entries()) {
      const isLast = index === path.length - 1;
      let next = Object.hasOwn(target, part) ? target[part] : undefined;
      if (isLast && array) {
        if (next === undefined) next = target[part] = [];
        if (!Array.isArray(next)) fail('Key redefined');
        const entry: Table = {};
        (next as unknown[]).push(entry);
        return entry;
      }
      if (next === undefined) next = target[part] = {};
      if (Array.isArray(next)) next = next.at(-1);
      if (!next || typeof next !== 'object') fail('Key redefined');
      target = next as Table;
    }
    return target;
  }

  while (i < source.length) {
    skipBlank();
    if (i >= source.length) break;
    if (startsWith('[[')) {
      i += 2;
      const path = key();
      if (!startsWith(']]')) fail('Expected ]]');
      i += 2;
      current = table(path, true);
    } else if (peek() === '[') {
      i++;
      const path = key();
      if (peek() !== ']') fail('Expected ]');
      i++;
      current = table(path, false);
    } else {
      const path = key();
      if (peek() !== '=') fail('Expected =');
      i++; skipSpaces();
      assign(current, path, value());
    }
    endOfLine();
  }
  return root;
}
