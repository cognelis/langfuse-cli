# Changelog

User-visible changes are recorded here. Versions follow the policy in
[MAINTENANCE.md](MAINTENANCE.md#version-policy).

This is a fork of [`langfuse/langfuse-cli`](https://github.com/langfuse/langfuse-cli)
maintained as a companion to `signoz-cli`; it shares that project's operational
contract and versioning policy. It is published as `@cognelis/langfuse-cli`;
version 2.0.0 is the first release of the fork and diverges from upstream 1.2.0.

## [Unreleased]

### Added

- `doctor` ends with a `contract` check. When the server version from its
  health probe would make `--api-version auto` pick a different API contract
  than the one in use — a self-hosted Langfuse 3.162.0 against the bundled
  4.16.0, for example — its message names both versions and the fix:
  `langfuse-cli profile update <profile> --api-version auto`, or
  `--api-version auto` / `LANGFUSE_API_VERSION=auto` without a profile. The
  check is advice: it passes, sends no extra request, and leaves `healthy` and
  the exit code unchanged.

### Changed

- The bundled skill explains when to query traces or observations under each API
  contract, how to count traces and failed traces in a time window, that omitted
  `--fields` groups come back empty rather than missing, and that `projects list`
  shows only the current key's project. Its CLI reference uses `api schema --json`
  and `LANGFUSE_HOST`.

### Fixed

- Action help, such as `langfuse-cli api traces list --help`, prints every
  option and body-field description in full, wrapped to the terminal width
  (100 columns when stdout is not a terminal), instead of cutting it with "…".
  The bundled contracts no longer cut descriptions at 200 characters either, so
  `--filter` shows its columns and examples and `api schema --json` carries the
  whole text.
- `api versions list|current|detect` honor `--json` and `--raw`, emitting
  `{"versions": [...]}`, `{"version", "requested"}` (plus `"detected"` under
  `auto`) and `{"detected", "version"}`. Without a format flag they print the
  same plain text as before, also in a pipe.

## [2.3.0] - 2026-10-12

### Added

- Per-profile API version: `profile add|update --api-version <version>` saves
  the contract a profile's calls use — an exact or major version, `latest`, or
  `auto` — so a self-hosted v3 server no longer needs the flag on every call.
  An explicit `--api-version` or `LANGFUSE_API_VERSION` still wins.
  `profile list` and `profile show` return it, `--api-version ""` clears it,
  and a version that no bundled contract matches is rejected when saved.

### Changed

- The bundled skill uses a production profile only when the request names
  production, answers questions about a whole environment from each of its
  profiles, runs `doctor` once per profile in a session, and explains how to
  work with a self-hosted v3 server through `--api-version auto` and boolean
  options. Its CLI reference installs `@cognelis/langfuse-cli` and points to
  profiles for credentials.

### Fixed

- `--help`, `--all` and bare boolean flags after an `api` command, such as
  `langfuse-cli api projects --help` or
  `langfuse-cli api observations list --is-root-observation`, no longer fail
  with "requires a value".
- A separate value after a boolean flag, as in `--is-root-observation true`,
  now reports "--is-root-observation is a boolean flag: use
  --is-root-observation or --is-root-observation=true" instead of a
  path-argument count error.
- Refusing a deprecated operation now says how to reach it on a self-hosted v3
  server: rerun with `--api-version auto`, or save that with
  `langfuse-cli profile update <profile> --api-version auto`.
- `langfuse-cli api versions --help` prints its actions instead of failing with
  "Unknown versions action".

## [2.2.0] - 2026-10-12

### Added

- Profile descriptions: `profile add|update --description` records what an
  environment is for, and `profile list` and `profile show` return it. A
  description change keeps the saved secret key, and re-running `init` keeps the
  description. The bundled skill chooses a profile by its name and description,
  and asks the user when several profiles or none could match.

### Fixed

- `--help` after a connection command, such as `langfuse-cli profile add --help`,
  prints usage instead of failing with "--help requires a value".
- Tables align columns that contain Chinese and other wide characters, as in
  signoz-cli.

## [2.1.0] - 2026-09-06

### Added

- Releases now carry a standalone executable for macOS, Linux, and Windows on
  both arm64 and x86-64, published as GitHub release assets alongside
  `checksums.txt`, `LICENSE`, and the changelog section for the version. Each
  binary is compiled **and started** on a runner of its own platform before the
  release is published — the reported version, the `api` command surface, the
  completion function name, the completion callback, and the usage exit code
  are all checked — and the assets are re-hashed against per-platform manifests
  before anything is uploaded. Downloading one needs no Node installation:

  ```sh
  curl -fsSL -o langfuse-cli \
    https://github.com/cognelis/langfuse-cli/releases/latest/download/langfuse-cli-darwin-arm64
  ```

- `bun run compile` accepts `--target <bun-triplet>` (for example
  `bun-linux-arm64`), so a checkout can build an executable for another
  platform. Without it the host platform is used, as before.

### Fixed

- A checkout on Windows can now build. The bundled OpenAPI snapshots are pinned
  by a SHA-256 over their text, and Git's default `core.autocrlf` on Windows
  rewrote every line ending, so the integrity check rejected all six snapshots.
  A repository-wide `.gitattributes` keeps them LF, and the mismatch now says
  when CRLF is the cause.

## [2.0.1] - 2026-09-06

### Changed

- Releases now publish from CI on a `vX.Y.Z` tag, through npm trusted
  publishing (OIDC). No npm token exists, and no one-time password is involved:
  `npm publish` only completes a passkey challenge inside a real terminal, so a
  local publish cannot be automated. The published artifacts are unchanged from
  2.0.0.

## [2.0.0] - 2026-09-06

Credentials, output, and agent-skill delivery were reworked to match the
`signoz-cli` operational contract. The upstream multi-version OpenAPI contract
system and its 593-case conformance suite are inherited unchanged.

### Added

- Named connection profiles. A profile records only the host and public key; the
  secret key is held by the operating-system credential store — the macOS
  keychain, the Freedesktop secret service, or Windows DPAPI — with a 0600 file
  as a last resort that every command reports as a downgrade. Every backend
  receives the secret on stdin, so it never appears in a process listing.
- `init`, a terminal-only guided setup that checks the address, takes the secret
  through a masked prompt, verifies it before storing it, activates the profile,
  and offers to install the agent skill. With input or output redirected it
  changes nothing and prints the equivalent non-interactive commands.
- `doctor`, an ordered read-only diagnosis of version, configuration,
  credentials, API connectivity, and authentication. The full report is written
  to stdout even when the command exits nonzero.
- `auth login|check|logout`, `profile add|update|list|show|use|remove`, and
  `config path|show`. `config show` and `profile show` report whether a secret
  exists, never its value.
- `skills install [--target all|codex|claude]`, which installs the bundled
  `SKILL.md` together with every `references/*.md` it links to, idempotently and
  without network access, preserving unrelated files in the target directory.
- `completion zsh|bash|fish`. The generated script carries no command table and
  calls back into a hidden `__complete` command, so completion follows CLI
  upgrades, profile edits, and `--api-version` — which changes the command
  surface from 22 resources on 3.50 to 37 on 4.16. Completion performs no
  network I/O and never opens the credential store.
- `bun run compile`, producing a single-file executable with all six API
  contracts embedded as unparsed strings, removing the dependency on a specific
  Node installation.
- Claude Code and Codex plugin manifests plus a repository marketplace
  descriptor under `plugins/langfuse-cli/`.

### Changed

- **The package is published as `@cognelis/langfuse-cli`.** The unscoped name
  belongs to upstream. Installing it provides the same `langfuse-cli` binary.
- **The executable is now `langfuse-cli`, not `langfuse`**, matching the name
  used by the companion CLIs.
- Connections resolve in a defined order: `--host`, then `--profile`, then
  `LANGFUSE_HOST`/`LANGFUSE_BASE_URL`, then the default profile. An explicit or
  environment host takes its credentials from the environment, so a stored
  profile can never silently supply a key for an address typed by hand.
  `LANGFUSE_SECRET_KEY` overrides a profile's stored key.
- `--output` now selects the format — `auto` (default), `table`, `json`, `raw` —
  instead of naming an output file. `auto` prints a table on a terminal and the
  JSON envelope everywhere else.
- `--json` emits a versioned envelope, `{schemaVersion, command, data, meta}`,
  replacing the previous `{status, headers, body}` shape.
- Human-readable output is rendered as tables aligned with `signoz-cli`: a
  header over a dashed rule, columns sized to their widest cell, `key: value`
  blocks with aligned colons, and the trailing `Profile:` line on stderr.
- `doctor` reports `pass`/`fail`/`skipped` as words in a table rather than
  symbols, so the report stays greppable.
- Changing a profile's address with `profile update --host` clears its stored
  secret first, and leaves the address unchanged if the secret cannot be
  cleared.
- The bundled skill targets this CLI directly: its `allowed-tools` list matches
  the real command name, and it instructs agents never to collect a secret key.

### Removed

- **`--secret-key`.** An argument-borne secret is recorded in shell history and
  is readable from the process list for the lifetime of the command. Passing it
  now fails with the replacement path rather than being reinterpreted.
- **`get-skill`**, which printed only the top-level `SKILL.md` and left every
  `references/*.md` link it declared unresolvable.
- `--output <path>` as a way to write a response to disk; that role moved to
  `--out-file <path>`.

### Security

- Secret keys no longer travel through argv on any path: `auth login` reads them
  from a masked prompt or `--secret-key-stdin`, and each credential backend is
  fed on stdin.
- The config file contains no secrets and is written with 0600 permissions, so
  it can be reviewed and copied without leaking access.

### Migration from upstream 1.2.0

| Before | Now |
| --- | --- |
| `npm i -g langfuse-cli` | `npm i -g @cognelis/langfuse-cli` |
| `langfuse api ...` | `langfuse-cli api ...` |
| `--secret-key sk-...` | `langfuse-cli auth login` (masked or `--secret-key-stdin`), or `LANGFUSE_SECRET_KEY` |
| `--output response.json` | `--out-file response.json` |
| `--json` → `{status, headers, body}` | `--json` → `{schemaVersion, command, data, meta}`; the body is now `.data` |
| piping without a flag → pretty-printed body | piping → the JSON envelope; use `--raw` for the bare payload |
| `langfuse get-skill > SKILL.md` | `langfuse-cli skills install` |

`schemaVersion` is a separate compatibility contract from the product version
and stays at `1`.
