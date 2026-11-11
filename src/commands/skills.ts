// Agent skill installation.
//
// The skill ships inside the package, so installing it needs no network access,
// no host and no credentials. `get-skill` used to print only the top-level
// SKILL.md, which silently dropped every references/*.md the skill points at;
// installing the whole bundled directory is what makes those links resolve.
//
// Installation is idempotent and additive: managed files are overwritten,
// anything else already in the target directory is left alone.
import { mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { CliError, EXIT_LOCAL } from "../errors";
import { skillVersion } from "../maintenance";
import packageJson from "../../package.json";

export type SkillTarget = "all" | "codex" | "claude";

export const SKILL_NAME = "langfuse";

let embeddedSkills: Readonly<Record<string, string>> | undefined;

/** Injected into standalone executables, like the bundled API contracts. */
export function setEmbeddedSkills(files: Readonly<Record<string, string>> | undefined): void {
  embeddedSkills = files;
}

export interface StatusResult {
  target: Exclude<SkillTarget, "all">;
  skill: string;
  directory: string;
  status: "current" | "different" | "missing" | "unreadable";
  bundledVersion: string;
  installedVersion: string | null;
  changedFiles: string[];
  missingFiles: string[];
  unreadableFiles: string[];
}


export interface InstallResult {
  target: Exclude<SkillTarget, "all">;
  directory: string;
  /** Per-file outcome, so a rerun can be seen to have changed nothing. */
  installed: string[];
  updated: string[];
  unchanged: string[];
}

/**
 * Locates the bundled skill directory.
 *
 * The built CLI reads it from dist/, next to the compiled entrypoint; running
 * from source falls back to the repository copy so the command behaves the same
 * during development.
 */
async function skillSourceDirectory(): Promise<string> {
  const candidates = [
    new URL(`./skills/${SKILL_NAME}/`, import.meta.url),
    new URL(`../plugins/langfuse-cli/skills/${SKILL_NAME}/`, import.meta.url),
    new URL(`../../plugins/langfuse-cli/skills/${SKILL_NAME}/`, import.meta.url),
  ];
  for (const candidate of candidates) {
    const path = fileURLToPath(candidate);
    try {
      const entry = await stat(join(path, "SKILL.md"));
      if (entry.isFile()) return path;
    } catch {
      continue;
    }
  }
  throw new CliError(
    "The bundled skill is missing from this installation",
    EXIT_LOCAL,
  );
}

async function bundledFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    // Node reports parentPath (>=20.12) or path (earlier) for nested entries.
    const parent =
      (entry as { parentPath?: string; path?: string }).parentPath ??
      (entry as { path?: string }).path ??
      root;
    files.push(relative(root, join(parent, entry.name)).split(sep).join("/"));
  }
  return files.sort();
}

function claudeSkillDirectory(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  const base = configured ? configured : join(homedir(), ".claude");
  return join(base, "skills", SKILL_NAME);
}

function codexSkillDirectory(): string {
  return join(homedir(), ".agents", "skills", SKILL_NAME);
}

/** Directory overrides, used by tests to avoid writing into a real home. */
export interface InstallOptions {
  claudeDirectory?: string;
  codexDirectory?: string;
}

function targetDirectories(
  target: SkillTarget,
  options: InstallOptions,
): Array<{ target: Exclude<SkillTarget, "all">; directory: string }> {
  const codex = {
    target: "codex" as const,
    directory: options.codexDirectory ?? codexSkillDirectory(),
  };
  const claude = {
    target: "claude" as const,
    directory: options.claudeDirectory ?? claudeSkillDirectory(),
  };
  if (target === "codex") return [codex];
  if (target === "claude") return [claude];
  return [codex, claude];
}

export function parseSkillTarget(value: string | undefined): SkillTarget {
  if (value === undefined) return "all";
  if (value === "all" || value === "codex" || value === "claude") return value;
  throw new CliError(
    `Unknown skill target: ${value} (expected all, codex or claude)`,
    EXIT_LOCAL,
  );
}

export async function installSkills(
  target: SkillTarget,
  options: InstallOptions = {},
): Promise<InstallResult[]> {
  const contents = await skillContents();

  const results: InstallResult[] = [];
  for (const { target: name, directory } of targetDirectories(target, options)) {
    const result: InstallResult = {
      target: name,
      directory,
      installed: [],
      updated: [],
      unchanged: [],
    };
    for (const [file, content] of contents) {
      const destination = join(directory, ...file.split("/"));
      let previous: string | undefined;
      try {
        previous = await readFile(destination, "utf8");
      } catch {
        previous = undefined;
      }
      if (previous === content) {
        result.unchanged.push(file);
        continue;
      }
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content);
      if (previous === undefined) result.installed.push(file);
      else result.updated.push(file);
    }
    results.push(result);
  }
  return results;
}

async function skillContents(): Promise<Map<string, string>> {
  if (embeddedSkills) {
    if (!embeddedSkills["SKILL.md"]) throw new CliError("The bundled skill is missing from this installation", EXIT_LOCAL);
    return new Map(Object.keys(embeddedSkills).sort().map((path) => [path, embeddedSkills![path]]));
  }
  const source = await skillSourceDirectory();
  const contents = new Map<string, string>();
  for (const path of await bundledFiles(source)) contents.set(path, await readFile(join(source, path), "utf8"));
  return contents;
}

async function readForComparison(path: string, maximum: number): Promise<Buffer> {
  if (!(await stat(path)).isFile()) throw new Error("not a regular file");
  const file = await open(path, "r");
  try {
    const bytes = Buffer.alloc(maximum);
    let length = 0;
    while (length < maximum) {
      const { bytesRead } = await file.read(bytes, length, maximum - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}

export async function inspectSkills(target: SkillTarget, options: InstallOptions = {}): Promise<StatusResult[]> {
  const contents = await skillContents();
  const results: StatusResult[] = [];
  for (const {target: agent, directory} of targetDirectories(target, options)) {
    const result: StatusResult = {
      target: agent, skill: SKILL_NAME, directory, status: "current", bundledVersion: packageJson.version,
      installedVersion: null, changedFiles: [], missingFiles: [], unreadableFiles: [],
    };
    for (const [relative, text] of contents) {
      const expected = Buffer.from(text);
      try {
        const actual = await readForComparison(join(directory, ...relative.split("/")), expected.length + 1);
        if (relative === "SKILL.md") result.installedVersion = skillVersion(actual.toString("utf8")) ?? null;
        if (!actual.equals(expected)) result.changedFiles.push(relative);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") result.missingFiles.push(relative);
        else result.unreadableFiles.push(relative);
      }
    }
    result.status = result.unreadableFiles.length ? "unreadable"
      : result.missingFiles.includes("SKILL.md") ? "missing"
      : result.changedFiles.length || result.missingFiles.length ? "different" : "current";
    results.push(result);
  }
  return results;
}
