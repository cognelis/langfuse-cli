import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CliError } from "../errors";
import { installSkills, parseSkillTarget } from "./skills";

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "langfuse-skills-"));
}

describe("skill target parsing", () => {
  test("defaults to installing for both agents", () => {
    expect(parseSkillTarget(undefined)).toBe("all");
  });

  test("accepts the named agents", () => {
    expect(parseSkillTarget("codex")).toBe("codex");
    expect(parseSkillTarget("claude")).toBe("claude");
  });

  test("rejects anything else instead of guessing", () => {
    expect(() => parseSkillTarget("copilot")).toThrow(CliError);
  });
});

describe("skill installation", () => {
  test("installs the SKILL.md together with every reference it links to", async () => {
    const directory = await scratch();
    try {
      const [result] = await installSkills("claude", {
        claudeDirectory: directory,
      });
      expect(result.target).toBe("claude");

      // The regression this guards: get-skill printed only SKILL.md, leaving
      // every references/*.md link dangling.
      const skill = await readFile(join(directory, "SKILL.md"), "utf8");
      const links = [
        ...new Set(skill.match(/references\/[a-z0-9-]+\.md/g) ?? []),
      ];
      expect(links.length).toBeGreaterThan(0);
      for (const link of links) {
        expect(await Bun.file(join(directory, link)).exists()).toBe(true);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reports installed, then updated, then unchanged", async () => {
    const directory = await scratch();
    try {
      const first = (await installSkills("claude", { claudeDirectory: directory }))[0];
      expect(first.installed.length).toBeGreaterThan(0);
      expect(first.updated).toEqual([]);
      expect(first.unchanged).toEqual([]);

      const second = (await installSkills("claude", { claudeDirectory: directory }))[0];
      expect(second.installed).toEqual([]);
      expect(second.updated).toEqual([]);
      expect(second.unchanged.length).toBe(first.installed.length);

      await writeFile(join(directory, "SKILL.md"), "stale content");
      const third = (await installSkills("claude", { claudeDirectory: directory }))[0];
      expect(third.updated).toEqual(["SKILL.md"]);
      expect(third.installed).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("leaves files it does not manage alone", async () => {
    const directory = await scratch();
    try {
      await mkdir(join(directory, "notes"), { recursive: true });
      await writeFile(join(directory, "notes", "local.md"), "keep me");
      await installSkills("claude", { claudeDirectory: directory });
      expect(await readFile(join(directory, "notes", "local.md"), "utf8")).toBe(
        "keep me",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("installs for both agents by default and only one when targeted", async () => {
    const claude = await scratch();
    const codex = await scratch();
    try {
      const both = await installSkills("all", {
        claudeDirectory: claude,
        codexDirectory: codex,
      });
      expect(both.map((entry) => entry.target).sort()).toEqual(["claude", "codex"]);
      expect(await Bun.file(join(claude, "SKILL.md")).exists()).toBe(true);
      expect(await Bun.file(join(codex, "SKILL.md")).exists()).toBe(true);

      const onlyCodex = await installSkills("codex", {
        claudeDirectory: join(claude, "unused"),
        codexDirectory: codex,
      });
      expect(onlyCodex).toHaveLength(1);
      expect(onlyCodex[0].target).toBe("codex");
      expect(await Bun.file(join(claude, "unused", "SKILL.md")).exists()).toBe(false);
    } finally {
      await rm(claude, { recursive: true, force: true });
      await rm(codex, { recursive: true, force: true });
    }
  });

  test("the bundled skill points at this CLI, not npx", async () => {
    const directory = await scratch();
    try {
      await installSkills("claude", { claudeDirectory: directory });
      const skill = await readFile(join(directory, "SKILL.md"), "utf8");
      expect(skill).not.toContain("npx langfuse-cli");
      expect(skill).not.toContain("bunx langfuse-cli");
      // The skill must never instruct an agent to collect a secret key.
      expect(skill).toContain("--secret-key-stdin");
      expect(skill).toContain("langfuse-cli init");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
