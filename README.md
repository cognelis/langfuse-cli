# langfuse-cli

`langfuse-cli` is a command-line client for repeatable [Langfuse](https://langfuse.com) work in terminals, CI jobs, and JSON pipelines. It keeps the secret key in the operating-system credential store, so a working setup never leaves a key in a dotfile, in an environment variable on disk, or in your shell history.

The repository also ships one Agent Skill and plugin manifests, so Codex and Claude Code can use the CLI without inventing commands or handling credentials.

## Install

Node.js 20+ or Bun. The CLI has zero runtime dependencies.

```sh
npm i -g @cognelis/langfuse-cli
langfuse-cli --version
```

Or from a checkout:

```sh
bun install
bun run build
npm i -g .
```

The binary is named `langfuse-cli`. The package is scoped because the bare
`langfuse-cli` name belongs to [upstream](https://github.com/langfuse/langfuse-cli).

### Single-file executable

`npm i -g .` ties the CLI to the Node version it was installed under. To get a
standalone executable with no Node dependency, and with all six API contracts
embedded:

```sh
bun run compile              # writes dist/langfuse-cli
bun run compile ~/bin/langfuse-cli
```

The contracts have to be embedded rather than read from disk: a compiled binary
has no `dist/contracts/` beside it, and Bun's bundler cannot see a runtime
`readFile(new URL(...))`. They are carried as unparsed strings and parsed on
demand, so startup does not pay for six snapshots. The result is ~60 MB (Bun
bundles its runtime) and starts in about 10 ms once the page cache is warm.

## Authenticate

For a workstation, start the guided setup. It creates or repairs a profile, masks the secret key while typing, verifies the connection before saving, stores the key in the operating-system credential store, activates the profile, and offers to install the bundled Skill.

```sh
langfuse-cli init
```

The setup is deliberately terminal-only and never starts implicitly. If input or output is redirected it exits without changing anything and prints the equivalent non-interactive commands.

For CI and short-lived shells, use environment variables. Keep the secret in the CI provider's secret store and disable shell tracing.

```sh
set +x
export LANGFUSE_HOST="https://cloud.langfuse.com"
export LANGFUSE_PUBLIC_KEY="pk-lf-..."
export LANGFUSE_SECRET_KEY="...from a secret store..."
langfuse-cli doctor --json
```

For scripts that intentionally persist a profile, profiles store only the host and the public key. The secret key is verified before it is stored in the keyring.

```sh
langfuse-cli profile add production --host https://langfuse.example.com --public-key pk-lf-...
langfuse-cli profile use production
printf '%s' "$LANGFUSE_SECRET_KEY" | langfuse-cli auth login --secret-key-stdin
langfuse-cli doctor --json
```

Running `langfuse-cli auth login` without `--secret-key-stdin` opens a masked prompt. Use `--no-verify` only for an intentional offline setup; the result records a warning. **There is intentionally no `--secret-key` flag**, so the secret never enters shell history or process listings. `config show` and `profile show` report only whether a key exists, never its value.

Keep test and production instances in separate profiles. Select one for a single command with `--profile`, or change the default with `profile use`:

```sh
langfuse-cli --profile test init
langfuse-cli --profile prod init
langfuse-cli profile use test
langfuse-cli --profile prod profile show
langfuse-cli --profile prod api projects list
```

Connections resolve in this order: `--host`, then `--profile`, then `LANGFUSE_HOST` (or `LANGFUSE_BASE_URL`), then the default profile. `LANGFUSE_SECRET_KEY` overrides the selected profile's stored key; unset it to use that profile's credential. Because `--host` and `LANGFUSE_HOST` name an address directly, they take their credentials from the environment — a stray profile can never silently supply a key for an address you typed by hand.

Changing an instance address with `profile update <name> --host <url>` clears the saved secret key before saving the new address, and tells you to authenticate again. An equivalent normalized URL preserves the key. If the credential store cannot clear the old key, the address is left unchanged.

### Where the secret actually goes

| Platform | Backend | Command used |
|---|---|---|
| macOS | login keychain | `security` |
| Linux | Freedesktop secret service | `secret-tool` |
| Windows | DPAPI, per-user encryption | `powershell` |
| fallback | `credentials.json`, mode 0600 | — |

Every backend receives the secret on **stdin**; it is never passed as an argument, so it stays out of the process list. The fallback is only chosen when no system store is reachable, and every command that relies on it prints a warning. Force it with `LANGFUSE_CREDENTIAL_STORE=file`.

## Diagnose a connection

Run the read-only diagnostic before remote automation or when a connection fails:

```sh
langfuse-cli doctor --json
```

It checks the CLI version, connection configuration, credential availability, API connectivity, and authentication **in that order** — nothing downstream is meaningful until the step before it passes. A completed run always writes its ordered `pass`/`fail`/`skipped` report to stdout, then exits with the code matching the first failure, so scripts should capture stdout before testing the status.

## Query Langfuse

```sh
# Discover resources
langfuse-cli api help
langfuse-cli api prompts help
langfuse-cli api prompts create help
langfuse-cli api schema --json        # machine-readable discovery

# Prompts
langfuse-cli api prompts list
langfuse-cli api prompts get my-prompt
langfuse-cli api prompts create --type text --name my-prompt --prompt 'Hello {{name}}'
langfuse-cli api prompts create --type chat --name support \
  --prompt '{"role":"system","content":"be nice"}' \
  --prompt '{"role":"user","content":"{{question}}"}'

# Observations, traces, datasets, scores
langfuse-cli api observations list --limit 10
langfuse-cli api observations list --trace-id <trace-id>
langfuse-cli api datasets list
langfuse-cli api dataset-items list --dataset-name my-dataset
langfuse-cli api scores list --limit 20

# Fetch every page of a paginated list (page- and cursor-based), max 1000 items
langfuse-cli api observations list --all
langfuse-cli api observations list --limit 100 --all --max-items 5000

# Preview the request without sending it
langfuse-cli api observations list --limit 5 --curl

# Pin an API snapshot for an older self-hosted deployment
langfuse-cli --api-version 3 api traces list
langfuse-cli --api-version 3.150.0 api traces list
langfuse-cli --api-version auto api prompts list   # detect via /api/public/health
```

OpenAPI tags and explicit route versions remain accepted aliases, for example `scores-v3 list` for the canonical `scores list`. Verbose OpenAPI `operationId` values remain available in `api schema --json` but are never required as CLI commands.

`--body-json` and `--body-file` provide a lossless input path for nested objects, arrays, unions, and free-form JSON. Simple request-body fields also get generated kebab-case flags (for example `--object-id` for the `objectId` field), consistent with query-parameter flags; wire names are never affected.

Union bodies with a discriminator (for example prompt create's chat vs. text variants) support field flags directly: the discriminator flag selects the variant and the CLI validates against that variant's schema — `langfuse-cli api help <resource> <action>` shows the per-variant fields. Unions without a clean discriminator stay `--body-json`-only rather than guessing.

## Command groups

```text
init
doctor
api <resource> <action>
auth login|check|logout
profile add|update|list|show|use|remove
config path|show
skills install [--target all|codex|claude]
completion zsh|bash|fish
```

## Output contract

Successful JSON output has a stable versioned envelope:

```json
{
  "schemaVersion": "1",
  "command": "api.projects.list",
  "data": {},
  "meta": {
    "status": 200,
    "profile": "prod",
    "host": "https://langfuse.example.com",
    "elapsedMs": 72
  }
}
```

Format selection follows `--output`:

| value | behaviour |
|---|---|
| `auto` (default) | a table on a terminal, the JSON envelope everywhere else |
| `table` | human-readable columns |
| `json` | the versioned envelope (same as `--json`) |
| `raw` | the payload only, no envelope (same as `--raw`) |

A human sees columns and a pipeline receives parseable output, neither having to
pass a flag:

```console
$ langfuse-cli profile list
current  name  host                                key
-------  ----  ----------------------------------  ------
         prod  https://langfuse.example.com        stored
*        test  https://langfuse-test.example.com   stored
Profile: test

$ langfuse-cli profile list | jq -r '.data[].name'
prod
test
```

Table output matches signoz-cli: a header over a dashed rule, columns sized to
their widest cell, `key: value` blocks with aligned colons, and the trailing
`Profile:` line on stderr so stdout stays clean even when a table is piped.

Diagnostics and warnings go to stderr; stdout stays clean for pipelines. The single exception is `doctor`, whose report *is* the result and so is written to stdout even when it exits nonzero. `--out-file <path>` writes the response body to a file instead of stdout.

## Exit codes

| Code | Meaning |
| ---: | --- |
| 0 | Successful API response or local command |
| 1 | Unexpected internal failure |
| 2 | Invalid command or input (usage); no request sent |
| 3 | Missing or invalid configuration/credentials; no request sent |
| 4 | Network, DNS, TLS, or timeout failure reaching the host |
| 5 | The API responded with a non-success HTTP status (response is still printed) |
| 6 | Local file or bundled-contract failure |

## Install the agent skill

```sh
# Install for both Codex and Claude Code (default)
langfuse-cli skills install
# Only one agent
langfuse-cli skills install --target codex
langfuse-cli skills install --target claude
```

The skill ships **inside the package**, so installation needs no network access, no host, and no credentials. It installs `SKILL.md` together with every `references/*.md` the skill links to — printing only the top-level file, as the removed `get-skill` command did, left those links dangling. The operation is idempotent: rerunning updates managed files, reports `unchanged` when nothing differs, and preserves unrelated files in the target directory.

Targets are `~/.agents/skills/langfuse` for Codex and `$CLAUDE_CONFIG_DIR/skills/langfuse` (default `~/.claude/skills/langfuse`) for Claude Code.

### Advanced: plugin lifecycle alternatives

The same skill directory is packaged for both agents at `plugins/langfuse-cli/skills/langfuse`. Use the plugin lifecycle instead when you want the repository marketplace installation.

For Claude Code:

```text
/plugin marketplace add /absolute/path/to/langfuse-cli
/plugin install langfuse-cli@langfuse-cli
```

For Codex:

```sh
codex plugin marketplace add /absolute/path/to/langfuse-cli
```

The Claude Code manifest is `plugins/langfuse-cli/.claude-plugin/plugin.json`; the Codex manifest is `plugins/langfuse-cli/.codex-plugin/plugin.json`.

## Shell completion

```sh
# zsh — any directory on $fpath
langfuse-cli completion zsh > ~/.zsh/completions/_langfuse-cli
exec zsh

# If that directory is new, put it on $fpath before compinit runs:
#   fpath=(~/.zsh/completions $fpath)
# oh-my-zsh users can instead use ~/.oh-my-zsh/completions, which is
# already on $fpath.

# bash
langfuse-cli completion bash > /usr/local/etc/bash_completion.d/langfuse-cli

# fish
langfuse-cli completion fish > ~/.config/fish/completions/langfuse-cli.fish
```

Completion covers commands, subcommands, global options, profile names, API
resources, their actions, and each action's own parameters:

```text
langfuse-cli <TAB>                     init doctor api auth profile config skills completion
langfuse-cli --profile <TAB>           test  prod                    (from your config)
langfuse-cli api <TAB>                 prompts traces observations datasets scores ...
langfuse-cli api prompts <TAB>         create delete get list update-version
langfuse-cli api prompts list --<TAB>  --name --label --tag --page --limit --all ...
```

Candidates are grouped, so subcommands are listed as their own block instead of
sorting alphabetically among the options — `--json` no longer lands between
`init` and `profile`. The wire format is `value<TAB>description<TAB>group`, and
the zsh script offers each group through a separate `_describe` call.

The generated script contains no command table. It calls back into a hidden
`__complete` command on every keypress, which is what keeps it correct when the
CLI is upgraded, when profiles change, and — the reason a static script would
be wrong here — when `--api-version` changes the command surface: 3.50 exposes
22 resources, 4.16 exposes 37. Completion never performs network I/O, so
`--api-version auto` falls back to the newest bundled contract rather than
probing the server.

The callback reads the config for profile names but never opens the credential
store, and any failure yields no candidates instead of an error, so a broken
config cannot corrupt the shell's display.

## Relationship to upstream

This is a fork of [`langfuse/langfuse-cli`](https://github.com/langfuse/langfuse-cli), maintained as a companion to `signoz-cli` with the same operational contract: keyring-backed credentials, named profiles, an ordered `doctor`, a versioned JSON envelope, stable exit codes, and a bundled agent skill. It diverges from upstream deliberately:

- `--secret-key` was removed; use `auth login` or `LANGFUSE_SECRET_KEY`.
- `--output <path>` became `--out-file <path>`; `--output` no longer selects a format.
- `--json` now emits the versioned envelope rather than `{status, headers, body}`.
- `get-skill` became `skills install`.
- `completion zsh|bash|fish` was added, backed by a `__complete` callback.
- `bun run compile` produces a standalone executable with the contracts embedded.
- `--output` selects the format (`auto|table|json|raw`) instead of naming a file,
  and human-readable output is rendered as tables aligned with signoz-cli.

The multi-version OpenAPI contract system and the conformance suite are inherited from upstream unchanged.

## API Reference

See the full [Langfuse API Reference](https://api.reference.langfuse.com/).

## Contributing

The CLI is implemented in TypeScript and runs on Node.js 20+ or Bun. It has zero external runtime dependencies and never parses OpenAPI during invocation.

See [MAINTENANCE.md](MAINTENANCE.md) for build, API snapshot, testing, and release workflows. The version-pinned black-box suite is documented separately in [`conformance/README.md`](conformance/README.md).
