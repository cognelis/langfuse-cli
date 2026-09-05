import { describe, expect, test } from "bun:test";

import { readdir, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { Config } from "../config";
import { setEmbeddedContracts } from "../contracts/loader";
import { CliError } from "../errors";
import {
  COMPLETION_SHELLS,
  complete,
  parseCompletionShell,
  renderCompletionScript,
  renderCompletions,
} from "./completion";

function configWithProfiles(): Config {
  const config = Config.empty("/tmp/langfuse-completion-test.json");
  config.addProfile("test", "https://test.example.com", "pk-test");
  config.addProfile("prod", "https://prod.example.com", "pk-prod");
  return config;
}

const deps = { config: configWithProfiles() };
const values = async (words: string[]) =>
  (await complete(words, deps)).map((item) => item.value);

/**
 * Contracts live in dist/, not next to the source, so the loader cannot find
 * them from a unit test. Injecting the built contracts exercises the same
 * embedding path the compiled binary uses.
 */
const contractsLoaded = await (async () => {
  const directory = resolve(import.meta.dirname, "../../dist/contracts");
  try {
    const embedded: Record<string, string> = {};
    for (const entry of await readdir(directory)) {
      if (!entry.endsWith(".json")) continue;
      embedded[basename(entry, ".json")] = await readFile(
        resolve(directory, entry),
        "utf8",
      );
    }
    if (!embedded.catalog) return false;
    setEmbeddedContracts(embedded);
    return true;
  } catch {
    return false;
  }
})();

if (!contractsLoaded) {
  console.warn(
    "dist/contracts is missing; contract-backed completion tests are skipped (run `bun run build`)",
  );
}

describe("shell selection", () => {
  test("accepts the supported shells", () => {
    for (const shell of COMPLETION_SHELLS) {
      expect(parseCompletionShell(shell)).toBe(shell);
    }
  });

  test("rejects an unknown or missing shell with usage", () => {
    expect(() => parseCompletionShell("nushell")).toThrow(CliError);
    expect(() => parseCompletionShell(undefined)).toThrow("completion <zsh|bash|fish>");
  });
});

describe("generated scripts", () => {
  test("the zsh function name matches the file name zsh will look for", () => {
    // Regression: zsh resolves the completion function from the file name
    // (_langfuse-cli). An underscored variant loads without error and then
    // never fires.
    const script = renderCompletionScript("zsh");
    expect(script).toContain("#compdef langfuse-cli");
    expect(script).toContain("_langfuse-cli() {");
    expect(script).toContain("compdef _langfuse-cli langfuse-cli");
    expect(script).not.toContain("_langfuse_cli");
  });

  test("the zsh script offers each group as its own block", () => {
    const script = renderCompletionScript("zsh");
    expect(script).toContain("_describe -t commands");
    expect(script).toContain("_describe -t options");
    expect(script).toContain("_describe -t values");
  });

  test("the zsh install note points at an fpath directory", () => {
    expect(renderCompletionScript("zsh")).toContain("~/.zsh/completions");
    expect(renderCompletionScript("zsh")).toContain("fpath=");
  });

  test("every script delegates to __complete instead of embedding a table", () => {
    for (const shell of COMPLETION_SHELLS) {
      const script = renderCompletionScript(shell);
      expect(script).toContain("__complete");
      // No command table: the surface changes with --api-version, so a baked-in
      // list would complete commands that do not exist on the version in use.
      expect(script).not.toContain("prompts");
      expect(script).not.toContain("observations");
    }
  });

  test("each script carries its own install instructions", () => {
    expect(renderCompletionScript("zsh")).toContain(".zsh/completions");
    expect(renderCompletionScript("bash")).toContain("bash_completion.d");
    expect(renderCompletionScript("fish")).toContain("fish/completions");
  });
});

describe("wire format", () => {
  test("emits value TAB description TAB group with a trailing directive", () => {
    const rendered = renderCompletions([
      { value: "api", description: "Interact with the API", group: "command" },
    ]);
    expect(rendered).toBe("api\tInteract with the API\tcommand\n:4\n");
  });

  test("collapses newlines so one candidate stays one line", () => {
    const rendered = renderCompletions([
      { value: "x", description: "line one\nline two", group: "option" },
    ]);
    expect(rendered.split("\n")).toHaveLength(3);
    expect(rendered).toContain("x\tline one line two\toption");
  });

  test("an empty candidate list still emits the directive", () => {
    expect(renderCompletions([])).toBe(":4\n");
  });
});

describe("grouping", () => {
  const groupsOf = async (words: string[]) => {
    const items = await complete(words, deps);
    return new Set(items.map((item) => item.group));
  };

  test("subcommands and options are tagged apart at the top level", async () => {
    const items = await complete([], deps);
    const commands = items.filter((item) => item.group === "command");
    const options = items.filter((item) => item.group === "option");
    // Regression: everything used to arrive ungrouped, so zsh listed --json
    // alphabetically among the subcommands.
    expect(commands.map((item) => item.value)).toContain("api");
    expect(options.map((item) => item.value)).toContain("--json");
    expect(commands.every((item) => !item.value.startsWith("--"))).toBe(true);
    expect(options.every((item) => item.value.startsWith("--"))).toBe(true);
  });

  test("profile names are values, not commands", async () => {
    expect(await groupsOf(["--profile"])).toEqual(new Set(["value"]));
    expect(await groupsOf(["profile", "use"])).toEqual(new Set(["value"]));
  });

  test("enum values are values", async () => {
    expect(await groupsOf(["skills", "install", "--target"])).toEqual(
      new Set(["value"]),
    );
  });

  test("subcommand groups contain only commands", async () => {
    expect(await groupsOf(["auth"])).toEqual(new Set(["command"]));
    expect(await groupsOf(["config"])).toEqual(new Set(["command"]));
  });
});

describe("candidates", () => {
  test("top level offers commands and global options", async () => {
    const result = await values([]);
    expect(result).toContain("init");
    expect(result).toContain("doctor");
    expect(result).toContain("api");
    expect(result).toContain("completion");
    expect(result).toContain("--profile");
  });

  test("--profile completes to configured profile names", async () => {
    expect((await values(["--profile"])).sort()).toEqual(["prod", "test"]);
  });

  test("profile subcommands that take a name complete profile names", async () => {
    expect((await values(["profile", "use"])).sort()).toEqual(["prod", "test"]);
    expect((await values(["profile", "remove"])).sort()).toEqual(["prod", "test"]);
  });

  test("profile list takes no further positional", async () => {
    expect(await values(["profile", "list"])).toEqual([]);
  });

  test("subcommand groups complete their actions", async () => {
    expect((await values(["auth"])).sort()).toEqual(["check", "login", "logout"]);
    expect((await values(["config"])).sort()).toEqual(["path", "show"]);
    expect(await values(["skills"])).toEqual(["install"]);
    expect((await values(["completion"])).sort()).toEqual(["bash", "fish", "zsh"]);
  });

  test("--target completes the skill install targets", async () => {
    expect(await values(["skills", "install", "--target"])).toEqual([
      "all",
      "codex",
      "claude",
    ]);
  });

  test("auth login offers the stdin path, never a secret flag", async () => {
    const result = await values(["auth", "login"]);
    expect(result).toContain("--secret-key-stdin");
    expect(result).not.toContain("--secret-key");
  });

  test("a value-taking option completes nothing rather than commands", async () => {
    // Otherwise `--host <TAB>` would offer subcommands as if they were a URL.
    expect(await values(["--host"])).toEqual([]);
    expect(await values(["--timeout"])).toEqual([]);
  });

  test("an unknown command yields no candidates", async () => {
    expect(await values(["nonsense"])).toEqual([]);
  });
});

describe.skipIf(!contractsLoaded)("api candidates come from the bundled contract", () => {
  test("api completes resources plus the discovery verbs", async () => {
    const result = await values(["api"]);
    expect(result).toContain("prompts");
    expect(result).toContain("traces");
    expect(result).toContain("help");
    expect(result).toContain("schema");
    expect(result).toContain("versions");
  });

  test("a resource completes its actions", async () => {
    const result = await values(["api", "prompts"]);
    expect(result).toContain("list");
    expect(result).toContain("get");
    expect(result).toContain("create");
  });

  test("an action completes its own parameters and body channels", async () => {
    const result = await values(["api", "prompts", "list"]);
    expect(result).toContain("--limit");
    expect(result).toContain("--name");
    expect(result).toContain("--body-json");
    // Pagination only makes sense on a GET.
    expect(result).toContain("--all");
  });

  test("--api-version selects which surface is completed", async () => {
    // experiments arrived after 3.50, so the two versions must differ.
    const modern = await values(["--api-version", "4.16.0", "api"]);
    const legacy = await values(["--api-version", "3.50.0", "api"]);
    expect(modern).toContain("experiments");
    expect(legacy).not.toContain("experiments");
    expect(modern.length).toBeGreaterThan(legacy.length);
  });

  test("--api-version completes the bundled versions plus the aliases", async () => {
    const result = await values(["--api-version"]);
    expect(result).toContain("latest");
    expect(result).toContain("auto");
    expect(result).toContain("4.16.0");
  });

  test("api versions completes its own actions", async () => {
    expect((await values(["api", "versions"])).sort()).toEqual([
      "current",
      "detect",
      "list",
    ]);
  });

  test("global options before a subcommand do not shift positional parsing", async () => {
    const withFlags = await values(["--profile", "prod", "api", "prompts"]);
    expect(withFlags).toContain("list");
    expect(withFlags).toContain("get");
  });
});
