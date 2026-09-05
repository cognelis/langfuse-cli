// Shell completion.
//
// The generated script is a thin bridge, exactly like cobra's: it carries no
// command table and instead calls back into `__complete` on every keypress.
// That matters here more than it would for a static command tree, because the
// command surface depends on --api-version — 68 operations on 3.50, 114 on
// 4.16 — so a script generated once would complete commands that do not exist
// on the version actually in use.
//
// Completion must never touch the network: a TAB keypress cannot wait on an
// HTTP round trip, so version detection falls back to the newest bundled
// contract instead of probing the server.
import type { Config } from "../config";
import { CliError, EXIT_USAGE } from "../errors";
import { loadApiContract, loadContractCatalog } from "../contracts/loader";
import type { ApiContract, ApiOperation } from "../contracts/types";
import {
  GLOBAL_BOOLEAN_FLAG_NAMES,
  GLOBAL_VALUE_FLAG_NAMES,
} from "../flags";

export const COMPLETION_SHELLS = ["zsh", "bash", "fish"] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

/** Candidate groups, so a shell can list commands apart from options. */
export type CompletionGroup = "command" | "option" | "value";

export interface CompletionItem {
  value: string;
  description: string;
  group: CompletionGroup;
}

export function parseCompletionShell(value: string | undefined): CompletionShell {
  if (value && (COMPLETION_SHELLS as readonly string[]).includes(value)) {
    return value as CompletionShell;
  }
  throw new CliError(
    `Usage: langfuse-cli completion <${COMPLETION_SHELLS.join("|")}>`,
    EXIT_USAGE,
  );
}

const command = (value: string, description: string): CompletionItem => ({
  value,
  description,
  group: "command",
});
const option = (value: string, description: string): CompletionItem => ({
  value,
  description,
  group: "option",
});
const literal = (value: string, description: string): CompletionItem => ({
  value,
  description,
  group: "value",
});

const TOP_LEVEL: CompletionItem[] = [
  command("init", "Guided setup: create or repair a profile"),
  command("doctor", "Diagnose the active connection"),
  command("api", "Interact with the Langfuse REST API"),
  command("auth", "login | check | logout"),
  command("profile", "Manage named connection profiles"),
  command("config", "Show the config path or its contents"),
  command("skills", "Install the bundled agent skill"),
  command("completion", "Generate a shell completion script"),
];

const SUBCOMMANDS: Record<string, CompletionItem[]> = {
  auth: [
    command("login", "Store a secret key for a profile"),
    command("check", "Verify the active credentials"),
    command("logout", "Remove a profile's stored secret key"),
  ],
  profile: [
    command("add", "Create a profile"),
    command("update", "Change a profile's host or public key"),
    command("list", "List profiles"),
    command("show", "Show one profile"),
    command("use", "Set the default profile"),
    command("remove", "Delete a profile and its secret"),
  ],
  config: [
    command("path", "Print the config file path"),
    command("show", "Print the config without credentials"),
  ],
  skills: [command("install", "Install the bundled skill")],
  completion: COMPLETION_SHELLS.map((shell) =>
    literal(shell, `Generate a ${shell} completion script`),
  ),
};

/** Subcommands whose next positional argument is a profile name. */
const PROFILE_POSITIONAL = new Set(["show", "use", "remove", "update"]);

const GLOBAL_FLAGS: CompletionItem[] = [
  ...GLOBAL_VALUE_FLAG_NAMES.map((name) => option(`--${name}`, "global option")),
  ...GLOBAL_BOOLEAN_FLAG_NAMES.map((name) => option(`--${name}`, "global flag")),
];

function flagValue(words: string[], flag: string): string | undefined {
  for (let index = 0; index < words.length; index++) {
    if (words[index] === flag) return words[index + 1];
    if (words[index].startsWith(`${flag}=`)) {
      return words[index].slice(flag.length + 1);
    }
  }
  return undefined;
}

/** Words that are not options or option values, in order. */
function positionals(words: string[]): string[] {
  const valueFlags = new Set(GLOBAL_VALUE_FLAG_NAMES.map((name) => `--${name}`));
  const result: string[] = [];
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (word.startsWith("--")) {
      if (valueFlags.has(word) && !word.includes("=")) index++;
      continue;
    }
    result.push(word);
  }
  return result;
}

async function contractFor(words: string[]): Promise<ApiContract | undefined> {
  const requested = flagValue(words, "--api-version");
  try {
    const catalog = await loadContractCatalog();
    // "auto" would need an HTTP probe, which completion must not do.
    const version =
      requested && requested !== "auto" && requested !== "latest"
        ? (catalog.versions.find((entry) => entry.version === requested)?.version ??
          catalog.latest)
        : catalog.latest;
    return await loadApiContract(version);
  } catch {
    return undefined;
  }
}

function resourceItems(contract: ApiContract): CompletionItem[] {
  const seen = new Map<string, number>();
  for (const operation of contract.operations) {
    const resource = operation.command.resource;
    seen.set(resource, (seen.get(resource) ?? 0) + 1);
  }
  return [...seen]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([resource, count]) =>
      command(resource, `${count} action${count === 1 ? "" : "s"}`),
    );
}

function actionItems(
  contract: ApiContract,
  resource: string,
): CompletionItem[] {
  return contract.operations
    .filter((operation) => operation.command.resource === resource)
    .sort((left, right) =>
      left.command.action.localeCompare(right.command.action),
    )
    .map((operation) =>
      command(
        operation.command.action,
        `${operation.method} ${operation.path}${operation.deprecated ? " [deprecated]" : ""}`,
      ),
    );
}

function operationFlagItems(operation: ApiOperation): CompletionItem[] {
  const items: CompletionItem[] = [];
  for (const parameter of operation.parameters) {
    if (parameter.location === "path") continue;
    items.push(
      option(
        `--${parameter.cliName}`,
        `${parameter.kind}${parameter.required ? ", required" : ""}`,
      ),
    );
  }
  for (const field of operation.requestBody?.fields ?? []) {
    items.push(
      option(
        `--${field.cliName}`,
        `body field${field.required ? ", required" : ""}`,
      ),
    );
  }
  items.push(
    option("--body-json", "lossless JSON request body"),
    option("--body-file", "read JSON body from a file or -"),
  );
  if (operation.method === "GET") {
    items.push(
      option("--all", "fetch every page"),
      option("--max-items", "cap --all"),
    );
  }
  return items;
}

export interface CompletionDeps {
  config: Config;
}

/**
 * Returns the candidates for the words typed so far. The shell filters them by
 * the partial word being typed, so everything valid at this position is
 * returned unfiltered.
 */
export async function complete(
  words: string[],
  deps: CompletionDeps,
): Promise<CompletionItem[]> {
  const previous = words[words.length - 1];

  // A value-taking global option: complete its value, not a new command.
  if (previous === "--profile") {
    return deps.config
      .names()
      .map((name) => literal(name, deps.config.profile(name)?.host ?? ""));
  }
  if (previous === "--target") {
    return [
      literal("all", "Codex and Claude Code"),
      literal("codex", "Codex only"),
      literal("claude", "Claude Code only"),
    ];
  }
  if (previous === "--output") {
    return [
      literal("auto", "table on a terminal, JSON otherwise"),
      literal("table", "human-readable columns"),
      literal("json", "versioned envelope"),
      literal("raw", "payload only"),
    ];
  }
  if (previous === "--api-version") {
    try {
      const catalog = await loadContractCatalog();
      return [
        literal("latest", `alias for ${catalog.latest}`),
        literal("auto", "detect from the server"),
        ...catalog.versions.map((entry) =>
          literal(entry.version, "bundled snapshot"),
        ),
      ];
    } catch {
      return [];
    }
  }
  if (previous === "--host" || previous === "--config-file" || previous === "--out-file" || previous === "--env" || previous === "--timeout" || previous === "--public-key" || previous === "--max-items") {
    return [];
  }

  const parts = positionals(words);
  const [head, second, third] = parts;

  if (!head) return [...TOP_LEVEL, ...GLOBAL_FLAGS];

  if (head === "api") {
    const contract = await contractFor(words);
    if (!contract) return [];
    if (!second) {
      return [
        ...resourceItems(contract),
        command("help", "Show API help"),
        command("schema", "Machine-readable command schema"),
        command("versions", "Bundled contract versions"),
      ];
    }
    if (second === "versions") {
      return third
        ? []
        : [
            command("list", "List bundled versions"),
            command("current", "Show the selected version"),
            command("detect", "Detect the server version"),
          ];
    }
    if (second === "help" || second === "schema") {
      return second === "help" && !third ? resourceItems(contract) : [];
    }
    if (!third) return actionItems(contract, second);
    const operation = contract.operations.find(
      (candidate) =>
        candidate.command.resource === second &&
        candidate.command.action === third,
    );
    return operation ? operationFlagItems(operation) : [];
  }

  const subcommands = SUBCOMMANDS[head];
  if (subcommands) {
    if (!second) return subcommands;
    // `profile show|use|remove|update <name>` takes a profile name.
    if (head === "profile" && !third && PROFILE_POSITIONAL.has(second)) {
      return deps.config
        .names()
        .map((name) => literal(name, deps.config.profile(name)?.host ?? ""));
    }
    if (head === "skills" && second === "install") {
      return [option("--target", "all | codex | claude")];
    }
    if (head === "auth" && second === "login") {
      return [
        option("--secret-key-stdin", "read the secret from stdin"),
        option("--no-verify", "store without verifying"),
        option("--public-key", "set the profile's public key"),
      ];
    }
    return [];
  }

  if (head === "doctor" || head === "init") return GLOBAL_FLAGS;
  return [];
}

/**
 * Serializes candidates for the shell bridge: value TAB description TAB group.
 *
 * The group is what lets zsh list commands and options as separate blocks;
 * without it every candidate lands in one alphabetical column and `--json`
 * sorts in among the subcommands.
 */
export function renderCompletions(items: CompletionItem[]): string {
  const lines = items.map(
    (item) =>
      `${item.value}\t${item.description.replace(/\s+/g, " ")}\t${item.group}`,
  );
  // Trailing directive line, mirroring cobra: 4 = do not fall back to files.
  return `${[...lines, ":4"].join("\n")}\n`;
}

export function renderCompletionScript(shell: CompletionShell): string {
  if (shell === "zsh") return ZSH_SCRIPT;
  if (shell === "bash") return BASH_SCRIPT;
  return FISH_SCRIPT;
}

const ZSH_SCRIPT = `#compdef langfuse-cli
# zsh completion for langfuse-cli.
#
# Install: write it to any directory on $fpath, then restart zsh.
#   langfuse-cli completion zsh > ~/.zsh/completions/_langfuse-cli
#   exec zsh
#
# If that directory is new, add it to $fpath before compinit runs:
#   fpath=(~/.zsh/completions $fpath)
#
# The script holds no command table: it asks the CLI on every keypress, so it
# stays correct across upgrades, --api-version changes and profile edits.
#
# Candidates arrive as "value<TAB>description<TAB>group" and are offered as
# separate blocks, so subcommands are not listed alphabetically among options.
_langfuse-cli() {
  local -a subcommands options literals
  local line value description group output

  output="$(command langfuse-cli __complete "\${(@)words[2,CURRENT-1]}" 2>/dev/null)" || return 1

  for line in \${(f)output}; do
    [[ "$line" == ':'* ]] && continue
    value="\${line%%$'\\t'*}"
    line="\${line#*$'\\t'}"
    description="\${line%%$'\\t'*}"
    group="\${line##*$'\\t'}"
    # _describe takes "value:description"; a literal colon must be escaped.
    description="\${description//:/\\\\:}"
    case "$group" in
      command) subcommands+=("\${value}:\${description}") ;;
      option)  options+=("\${value}:\${description}") ;;
      *)       literals+=("\${value}:\${description}") ;;
    esac
  done

  local ret=1
  (( \${#subcommands} )) && { _describe -t commands 'command' subcommands && ret=0 }
  (( \${#literals} ))    && { _describe -t values 'value' literals && ret=0 }
  (( \${#options} ))     && { _describe -t options 'option' options && ret=0 }
  return ret
}

compdef _langfuse-cli langfuse-cli
`;

const BASH_SCRIPT = `# bash completion for langfuse-cli.
#
# Install:
#   langfuse-cli completion bash > /usr/local/etc/bash_completion.d/langfuse-cli
#   # or: langfuse-cli completion bash > ~/.langfuse-cli-completion.bash
#   #     echo 'source ~/.langfuse-cli-completion.bash' >> ~/.bashrc
_langfuse-cli() {
  local output line current
  local -a values=()

  current="\${COMP_WORDS[COMP_CWORD]}"
  output="$(langfuse-cli __complete "\${COMP_WORDS[@]:1:COMP_CWORD-1}" 2>/dev/null)" || return

  while IFS= read -r line; do
    [[ "$line" == ':'* ]] && continue
    values+=("\${line%%$'\\t'*}")
  done <<< "$output"

  mapfile -t COMPREPLY < <(compgen -W "\${values[*]}" -- "$current")
}

complete -F _langfuse_cli langfuse-cli
`;

const FISH_SCRIPT = `# fish completion for langfuse-cli.
#
# Install:
#   langfuse-cli completion fish > ~/.config/fish/completions/langfuse-cli.fish
function __langfuse_cli_complete
    set -l tokens (commandline -opc)
    # fish renders "value<TAB>description" natively.
    langfuse-cli __complete $tokens[2..-1] 2>/dev/null \\
        | string match -r -v '^:' \\
        | string replace -r '\\t[^\\t]*$' ''
end

complete -c langfuse-cli -f -a '(__langfuse_cli_complete)'
`;
