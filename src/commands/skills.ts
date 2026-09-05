// Agent skill installation.
//
// The skill ships inside the package, so installing it needs no network access,
// no host and no credentials. `get-skill` used to print only the top-level
// SKILL.md, which silently dropped every references/*.md the skill points at;
// installing the whole bundled directory is what makes those links resolve.
//
// Installation is idempotent and additive: managed files are overwritten,
// anything else already in the target directory is left alone.
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { CliError, EXIT_LOCAL } from "../errors";

export type SkillTarget = "all" | "codex" | "claude";

export const SKILL_NAME = "langfuse";

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
  const source = await skillSourceDirectory();
  const files = await bundledFiles(source);
  const contents = new Map<string, string>();
  for (const file of files) {
    contents.set(file, await readFile(join(source, file), "utf8"));
  }

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
