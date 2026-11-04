/** Engineering check only. No configure, service, MCP, or printer action. */
import { readFile, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = resolve(process.argv[2]);
const source = join(root, "Payload/source");
const roots = [
  "packages/contracts",
  "services/project",
  "services/printer-handoff",
  "services/companion",
];
let dependencies = 0,
  exportsChecked = 0;
async function checkPackage(folder, seen = new Set()) {
  const real = await realpath(folder);
  if (seen.has(real)) return;
  seen.add(real);
  const manifest = JSON.parse(
    await readFile(join(folder, "package.json"), "utf8"),
  );
  for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
    if (!String(version).startsWith("file:")) continue;
    const dependency = join(folder, "node_modules", name);
    const pkg = JSON.parse(
      await readFile(join(dependency, "package.json"), "utf8"),
    );
    if (pkg.name !== name)
      throw new Error(`Wrong dependency for ${manifest.name}: ${name}`);
    dependencies++;
    await checkPackage(dependency, seen);
  }
  for (const value of Object.values(manifest.exports ?? {})) {
    const entry =
      typeof value === "string" ? value : (value.import ?? value.default);
    if (entry && entry.endsWith(".js")) {
      await import(pathToFileURL(join(folder, entry)));
      exportsChecked++;
    }
  }
}
for (const path of roots) await checkPackage(join(source, path));
const addresses = await import(
  pathToFileURL(join(source, "services/companion/dist/lan-addresses.js"))
);
if (typeof addresses.discoverAddresses !== "function")
  throw new Error("Missing discoverAddresses export");
console.log(
  JSON.stringify({
    internalDependencies: dependencies,
    exportsChecked,
    lanAddressModule: "imported",
    resources: root,
  }),
);
