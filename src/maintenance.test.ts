import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json";
import { packageCheck, releaseCheck, skillCheck, skillVersion } from "./maintenance";
import { DoctorReport } from "./doctor";

describe("doctor maintenance checks", () => {
  test("compares release versions numerically without changing health", () => {
    for (const [current, tag, state] of [["1.9.0", "v1.10.0", "update_available"], ["2.0.0", "2.0.0", "current"], ["3.0.0", "v2.0.0", "ahead"]]) {
      const check = releaseCheck(current, { tag_name: tag });
      expect(check.message).toStartWith(state);
      const report = new DoctorReport(current);
      report.append(check);
      expect(report.healthy).toBe(true);
      expect(report.exitCode).toBe(0);
    }
    for (const tag of ["", "broken", "01.2.3", "1.2.3-beta"]) expect(releaseCheck("1.2.3", { tag_name: tag }).status).toBe("skipped");
  });
  test("distinguishes missing, old, installed and loaded Skills", async () => {
    const root = await mkdtemp(join(tmpdir(), "langfuse-doctor-"));
    try {
      expect((await skillCheck([root], "")).message).toStartWith("not_installed:");
      await mkdir(join(root, "langfuse"));
      await writeFile(join(root, "langfuse/SKILL.md"), "---\nname: old\n---\n");
      expect((await skillCheck([root], "")).message).toContain(": unknown");
      await writeFile(join(root, "langfuse/SKILL.md"), `---\nversion: ${pkg.version}\n---\n`);
      expect((await skillCheck([root], "")).message).toStartWith("installed_not_loaded:");
      expect((await skillCheck([root], "0.0.0")).message).toStartWith("reload_required:");
      expect((await skillCheck([root], pkg.version)).message).toStartWith("current:");
      await rm(join(root, "langfuse/SKILL.md"));
      await mkdir(join(root, "langfuse/SKILL.md"));
      expect((await skillCheck([root], "")).message).toStartWith("invalid:");
      expect(skillVersion("version: 1.2.3")).toBeUndefined();
      expect(skillVersion("---\nversion: 1.2.3\nversion: 2.0.0\n---")).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("release requests omit credentials and reject malformed or oversized bodies", async () => {
    const original = globalThis.fetch;
    try {
      for (const response of [new Response("invalid"), new Response("x".repeat(65537)), new Response("unavailable", { status: 503 })]) {
        globalThis.fetch = (async (_url, init) => {
          expect(new Headers(init?.headers).has("authorization")).toBe(false);
          return response;
        }) as typeof fetch;
        expect((await packageCheck("https://example.com/release", 1000)).status).toBe("skipped");
      }
      globalThis.fetch = (async () => Response.json({ tag_name: "v99.0.0" })) as typeof fetch;
      expect((await packageCheck("https://example.com/release", 1000)).message).toStartWith("update_available:");
    } finally { globalThis.fetch = original; }
  });

  test("release timeouts leave connection health unchanged", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
    })) as typeof fetch;
    try {
      const report = new DoctorReport(pkg.version);
      report.append(await packageCheck("https://example.com/release", 10));
      expect(report.toJSON().checks.at(-1)?.status).toBe("skipped");
      expect(report.healthy).toBe(true);
      expect(report.exitCode).toBe(0);
    } finally { globalThis.fetch = original; }
  });
});
