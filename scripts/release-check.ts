// Release consistency check.
//
// Mirrors the signoz-cli workflow: it verifies that the declared version is
// coherent across every manifest and that the changelog records it, and then
// stops. It does not commit, tag, push, publish, or install anything — the
// release decision stays with a human.
//
// This fork publishes under its own scope. The name check is the guard that
// matters: the unscoped `langfuse-cli` belongs to upstream, and a scoped
// package defaults to restricted access, which would publish something meant
// to be installable as private.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

/** Files that must all carry the same product version. */
const VERSIONED = [
  { path: "package.json", read: (data: Record<string, any>) => data.version },
  {
    path: ".claude-plugin/marketplace.json",
    read: (data: Record<string, any>) => data.metadata?.version,
  },
  {
    path: "plugins/langfuse-cli/.claude-plugin/plugin.json",
    read: (data: Record<string, any>) => data.version,
  },
  {
    path: "plugins/langfuse-cli/.codex-plugin/plugin.json",
    read: (data: Record<string, any>) => data.version,
  },
] as const;

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const problems: string[] = [];

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve(root, path), "utf8"));
}

const manifest = await readJson("package.json");
const version = String(manifest.version ?? "");

if (!SEMVER.test(version)) {
  problems.push(
    `package.json version "${version}" is not a plain MAJOR.MINOR.PATCH version`,
  );
}
const name = String(manifest.name ?? "");
if (!name.startsWith("@cognelis/")) {
  problems.push(
    `package.json name "${name}" must stay under the @cognelis scope; the bare "langfuse-cli" belongs to upstream`,
  );
}
if (manifest.private !== undefined) {
  problems.push(
    'package.json must not set "private" now that the fork publishes under its own scope',
  );
}
const access = (manifest.publishConfig as Record<string, unknown> | undefined)?.access;
if (access !== "public") {
  problems.push(
    'package.json must set "publishConfig.access" to "public"; a scoped package is otherwise published as restricted',
  );
}
const binaries = Object.keys(
  (manifest.bin as Record<string, string> | undefined) ?? {},
);
if (binaries.length !== 1 || binaries[0] !== "langfuse-cli") {
  problems.push(
    `package.json must expose exactly one binary named langfuse-cli, found ${binaries.join(", ") || "none"}`,
  );
}

for (const entry of VERSIONED.slice(1)) {
  const declared = entry.read(await readJson(entry.path));
  if (declared !== version) {
    problems.push(
      `${entry.path} declares ${declared ?? "no version"}, expected ${version}`,
    );
  }
}

const changelog = await readFile(resolve(root, "CHANGELOG.md"), "utf8");
const headings = [...changelog.matchAll(/^## \[([^\]]+)\](?: - (\S+))?/gm)].map(
  (match) => ({ version: match[1], date: match[2] }),
);

if (headings[0]?.version !== "Unreleased") {
  problems.push("CHANGELOG.md must start with an `## [Unreleased]` section");
}

const released = headings.filter((entry) => entry.version !== "Unreleased");
const current = released.find((entry) => entry.version === version);
if (!current) {
  problems.push(`CHANGELOG.md has no `+"`## ["+`${version}]\` section`);
} else if (!current.date) {
  problems.push(`CHANGELOG.md entry for ${version} has no date`);
}

const seen = new Set<string>();
for (const entry of released) {
  if (seen.has(entry.version)) {
    problems.push(`CHANGELOG.md lists ${entry.version} more than once`);
  }
  seen.add(entry.version);
}

// Newest first, so each entry must be strictly greater than the one below it.
const rank = (value: string): number[] =>
  value.split(".").map((part) => Number.parseInt(part, 10));
for (let index = 0; index + 1 < released.length; index++) {
  const [a, b] = [rank(released[index].version), rank(released[index + 1].version)];
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) continue;
  const ordered = a.some((part, position) => part > b[position]) &&
    !a.some((part, position) =>
      part < b[position] && a.slice(0, position).every((v, i) => v === b[i]),
    );
  if (!ordered) {
    problems.push(
      `CHANGELOG.md lists ${released[index].version} above ${released[index + 1].version}; entries must be newest first`,
    );
  }
}

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`✗ ${problem}\n`);
  process.stderr.write(
    `\n${problems.length} problem(s). Nothing was changed.\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `Version ${version} is consistent across ${VERSIONED.length} manifests and recorded in CHANGELOG.md\n`,
);
