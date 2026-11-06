import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Every control method the Linux UI calls must pass the native bridge's allowlist (src-tauri/src/protocol.rs
// `allowed`), or the packaged app refuses it with "This operation is not available to this window" while the
// domain tests, which bypass the bridge, still pass (Codex review on #365: objects.colourMapping).
const root = join(import.meta.dirname, "..");
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(dir, entry.name))
      : /\.(ts|tsx)$/.test(entry.name)
        ? [readFileSync(join(dir, entry.name), "utf8")]
        : [],
  );

test("every control method the UI calls is on the native bridge's allowlist", () => {
  const called = new Set(
    sources(join(root, "src")).flatMap((text) =>
      [...text.matchAll(/\bcall\s*(?:<[^()]*?>)?\(\s*"([a-zA-Z]+(?:\.[a-zA-Z]+)+)"/g)].map((m) => m[1]!),
    ),
  );
  const protocol = readFileSync(join(root, "src-tauri/src/protocol.rs"), "utf8");
  const body = protocol.slice(protocol.indexOf("pub fn allowed"), protocol.indexOf("}", protocol.indexOf("pub fn allowed")));
  const allowed = new Set([...body.matchAll(/"([a-zA-Z.]+)"/g)].map((m) => m[1]!));
  assert.ok(called.has("objects.colourMapping"), "the print sheet asks for the colour mapping");
  assert.ok(called.size > 20, `found the UI's calls (${called.size})`);
  assert.deepEqual([...called].filter((method) => !allowed.has(method)).sort(), []);
});
