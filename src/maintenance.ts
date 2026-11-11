// Informational doctor checks; connection health and output formatting stay unchanged.
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import packageJson from "../package.json";
import type { DoctorCheck } from "./doctor";

const VERSION = packageJson.version;
const MAX_BYTES = 64 * 1024;
const INSTALL = "langfuse-cli skills install";

function version(value: string): number[] | undefined {
  if (!/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return;
  const parts = value.replace(/^v/, "").split(".").map(Number);
  return parts.every(Number.isSafeInteger) ? parts : undefined;
}

export function releaseCheck(current: string, body: unknown): DoctorCheck {
  const release = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const latest = typeof release.tag_name === "string" ? release.tag_name : "";
  const a = version(current), b = version(latest);
  if (!a || !b || release.draft === true || release.prerelease === true) {
    return { name: "package", status: "skipped", message: `unknown: installed ${current}; release response has no valid stable version` };
  }
  const difference = a.map((part, index) => part - b[index]).find((part) => part !== 0) ?? 0;
  const state = difference < 0 ? "update_available" : difference > 0 ? "ahead" : "current";
  let message = `${state}: installed ${current}; latest ${latest.replace(/^v/, "")}`;
  if (difference < 0) message += `; upgrade langfuse-cli (npm: npm install -g @cognelis/langfuse-cli@latest), run \`${INSTALL}\`, then reload the agent context`;
  return { name: "package", status: "pass", message };
}

export async function packageCheck(endpoint: string, timeoutMs: number): Promise<DoctorCheck> {
  const unavailable: DoctorCheck = { name: "package", status: "skipped", message: `unavailable: installed ${VERSION}; release lookup failed; retry later or use --no-update-check` };
  try {
    const url = new URL(endpoint);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return unavailable;
    const response = await fetch(url, {
      headers: { accept: "application/vnd.github+json", "user-agent": `langfuse-cli/${VERSION}` },
      redirect: "error", signal: AbortSignal.timeout(Math.max(1, Math.min(5000, Math.floor(timeoutMs)))),
    });
    if (!response.ok || Number(response.headers.get("content-length")) > MAX_BYTES) {
      await response.body?.cancel();
      return unavailable;
    }
    const reader = response.body?.getReader();
    if (!reader) return unavailable;
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > MAX_BYTES) { await reader.cancel(); return unavailable; }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    return releaseCheck(VERSION, JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch { return unavailable; }
}

export function skillVersion(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  if (lines.shift()?.trim() !== "---") return;
  let found: string | undefined;
  for (const line of lines) {
    if (line.trim() === "---") return found;
    if (line.startsWith("version:")) {
      if (found !== undefined) return;
      const raw = line.slice(8).trim();
      const value = /^(['"])(.*)\1$/.exec(raw)?.[2] ?? raw;
      if (!version(value)) return;
      found = value.replace(/^v/, "");
    }
  }
}

export async function skillCheck(roots: string[], loaded: string): Promise<DoctorCheck> {
  loaded = loaded.trim();
  const loadedVersion = version(loaded) ? loaded.replace(/^v/, "") : loaded ? "unknown" : "none";
  let installed = 0, current = 0;
  const issues: string[] = [];
  for (const root of new Set(roots)) {
    const path = join(root, "langfuse", "SKILL.md");
    try {
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size > MAX_BYTES) throw new Error("unreadable");
      const actual = skillVersion(await readFile(path, "utf8")) ?? "unknown";
      installed++;
      if (actual === VERSION) current++;
      else issues.push(`${path}: ${actual}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") issues.push(`${path}: unreadable`);
    }
  }
  const state = loadedVersion === VERSION ? "current"
    : loaded && current > 0 ? "reload_required"
    : loaded ? loadedVersion === "unknown" ? "unknown" : "outdated"
    : current > 0 ? "installed_not_loaded" : installed > 0 ? "outdated" : issues.length ? "invalid" : "not_installed";
  let message = `${state}: bundled ${VERSION}; loaded ${loadedVersion}; installed ${installed}, current ${current}`;
  if (issues.length) message += `; ${issues.join("; ")}`;
  if (!current || issues.length) message += `; run \`${INSTALL}\``;
  if (loadedVersion !== VERSION) message += "; reload the agent context (or load the Skill if not yet loaded)";
  return { name: "skill", status: "pass", message };
}

export async function maintenanceChecks(skipUpdate: boolean, timeoutMs: number): Promise<DoctorCheck[]> {
  const roots = [homedir(), process.cwd()].flatMap((base) => [".agents", ".codex", ".claude"].map((agent) => join(base, agent, "skills")));
  if (process.env.CLAUDE_CONFIG_DIR) roots.push(join(process.env.CLAUDE_CONFIG_DIR, "skills"));
  const packageResult = skipUpdate
    ? { name: "package", status: "skipped" as const, message: "disabled by --no-update-check" }
    : await packageCheck(process.env.LANGFUSE_CLI_RELEASE_API ?? "https://api.github.com/repos/cognelis/langfuse-cli/releases/latest", timeoutMs);
  return [packageResult, await skillCheck(roots, process.env.LANGFUSE_CLI_SKILL ?? "")];
}
