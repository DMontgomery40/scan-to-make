// The MCP surface app code touches, read from the TypeScript AST (not text search): every snake_case
// string or object key in companion/printer-handoff sources, and every key of the counterpart/1 schemas.
import ts from 'typescript';
import {readFileSync, readdirSync} from 'node:fs';
import {join, relative} from 'node:path';

const SNAKE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

function files(dir) {
  return readdirSync(dir, {withFileTypes: true}).flatMap(entry =>
    entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [join(dir, entry.name)] : []);
}

export function surface(repo) {
  const names = new Map();
  for (const root of ['services/companion/src', 'services/printer-handoff/src']) {
    for (const file of files(join(repo, root))) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = node => {
        let text;
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text;
        else if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || ts.isPropertySignature(node)) && node.name && ts.isIdentifier(node.name)) text = node.name.text;
        if (text && SNAKE.test(text)) names.set(text, (names.get(text) ?? new Set()).add(relative(repo, file)));
        // An object literal with any snake_case key is an MCP argument or result shape: its one-word keys count too.
        if (ts.isObjectLiteralExpression(node)) {
          const keys = node.properties.flatMap(property => property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? [property.name.text] : []);
          if (keys.some(key => SNAKE.test(key))) for (const key of keys) names.set(key, (names.get(key) ?? new Set()).add(relative(repo, file)));
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  // Result fields of the counterpart/1 contract: keys of z.object({...}) in counterpart.ts.
  const fields = new Set();
  const contract = join(repo, 'services/printer-handoff/src/counterpart.ts');
  const source = ts.createSourceFile(contract, readFileSync(contract, 'utf8'), ts.ScriptTarget.Latest, true);
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'object'
        && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
      for (const property of node.arguments[0].properties) if (property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) fields.add(property.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return {names, fields};
}

/** Backticked names in the contract doc's tables, by section heading. */
export function documented(markdown) {
  const sections = new Map(); let current;
  for (const line of markdown.split('\n')) {
    const heading = /^## (.+)$/.exec(line);
    if (heading) { current = heading[1].trim(); sections.set(current, new Set()); continue; }
    if (current && line.startsWith('|')) {
      const first = line.split('|')[1] ?? '';
      for (const match of first.matchAll(/`([^`]+)`/g)) sections.get(current).add(match[1]);
    }
  }
  return sections;
}

if (process.argv[2]) {
  const {names, fields} = surface(process.argv[2]);
  for (const [name, where] of [...names].sort()) console.log(name + '\t' + [...where].join(','));
  console.log('--- counterpart/1 fields'); console.log([...fields].sort().join(' '));
}
