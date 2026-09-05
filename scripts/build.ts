import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { loadCatalog, readVerifiedSpec } from "../conformance/src/catalog";
import { goldenSurfaceDiff } from "../conformance/src/goldens";
import {
  assertOverridesApplied,
  compileApiContract,
} from "../src/contracts/compiler";
import type { ApiContract, ApiContractCatalog } from "../src/contracts/types";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const contractsDirectory = resolve(dist, "contracts");

await rm(dist, { recursive: true, force: true });
await mkdir(contractsDirectory, { recursive: true });

const sourceCatalog = await loadCatalog();
const contractCatalog: ApiContractCatalog = {
  schemaVersion: 1,
  latest: sourceCatalog.versions.at(-1)!.version,
  versions: sourceCatalog.versions.map((entry) => ({
    version: entry.version,
    sourceSha256: entry.sha256,
  })),
};

let totalOperations = 0;
const contracts: ApiContract[] = [];
for (const entry of sourceCatalog.versions) {
  const raw = await readVerifiedSpec(entry);
  const contract = compileApiContract(entry, raw);
  contracts.push(contract);
  const differences = await goldenSurfaceDiff(entry.version, contract.operations);
  if (differences.length > 0) {
    for (const difference of differences) {
      process.stderr.write(`${difference}\n`);
    }
    process.stderr.write(
      `Command surface differs from committed goldens; run bun run goldens:update and review the diff\n`,
    );
    process.exit(1);
  }
  totalOperations += contract.operations.length;
  await Bun.write(
    resolve(contractsDirectory, `${entry.version}.json`),
    `${JSON.stringify(contract)}\n`,
  );
}
assertOverridesApplied(contracts);
await Bun.write(
  resolve(contractsDirectory, "catalog.json"),
  `${JSON.stringify(contractCatalog)}\n`,
);

// The agent skill ships inside the package so `skills install` needs no network
// access. Copying the whole directory is what keeps every references/*.md the
// SKILL.md links to resolvable once installed.
const skillSource = resolve(root, "plugins/langfuse-cli/skills/langfuse");
const skillTarget = resolve(dist, "skills/langfuse");
const skillEntries = await readdir(skillSource, {
  recursive: true,
  withFileTypes: true,
});
let skillFileCount = 0;
for (const entry of skillEntries) {
  if (!entry.isFile()) continue;
  const parentPath =
    (entry as { parentPath?: string; path?: string }).parentPath ??
    (entry as { path?: string }).path ??
    skillSource;
  const absolute = resolve(parentPath, entry.name);
  const target = resolve(skillTarget, relative(skillSource, absolute));
  await mkdir(dirname(target), { recursive: true });
  await Bun.write(target, Bun.file(absolute));
  skillFileCount += 1;
}
if (skillFileCount === 0) {
  process.stderr.write(`No skill files found under ${skillSource}\n`);
  process.exit(1);
}

const result = await Bun.build({
  entrypoints: [resolve(root, "src/cli.ts")],
  outdir: dist,
  target: "node",
  format: "esm",
  minify: true,
});
if (!result.success) {
  for (const log of result.logs) process.stderr.write(`${log}\n`);
  process.exit(1);
}

process.stdout.write(
  `Built native Bun CLI with ${sourceCatalog.versions.length} contracts, ${totalOperations} operations and ${skillFileCount} skill files\n`,
);
