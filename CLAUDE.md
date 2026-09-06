# langfuse-cli — agent notes

Fork of `langfuse/langfuse-cli`, published as **`@cognelis/langfuse-cli`**,
maintained as a companion to `signoz-cli` with the same operational contract.
Full detail lives in [MAINTENANCE.md](MAINTENANCE.md); this file is the short
version an agent needs before touching the repo.

## Releasing — do it yourself, do not ask the user

Releasing is fully automated. **Do not ask the user to run `npm publish`.**

```sh
# 1. record the change while working
#    CHANGELOG.md → ## [Unreleased] → Added / Changed / Fixed / Removed / Security

# 2. move Unreleased into a dated version section, and bump the version in
#    all four manifests (see "Version policy" below)

# 3. gates — all must pass
bun run release:check
bun run typecheck
bun test
bun run conformance:all

# 4. commit, tag, push. The tag is what publishes.
git commit -m "chore: release X.Y.Z"
git push origin main
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

Pushing the `vX.Y.Z` tag triggers `.github/workflows/release.yml`, which runs
four stages, each gating the next:

1. `validate` — re-runs every gate and fails unless the tag matches
   `package.json` and `repository.url` names the repository it runs in.
2. `binaries` — six parallel jobs (macOS, Linux, Windows × arm64, x86-64), each
   compiling **and starting** its own standalone executable.
3. `release` — re-hashes every artifact and publishes the GitHub release with
   the binaries, `checksums.txt`, `LICENSE` and the changelog section.
4. `npm` — verifies the packed tarball actually contains the CLI, contracts and
   skill, then publishes through **npm trusted publishing (OIDC)** — no token,
   no OTP.

If a platform build flakes after the tag is public, re-run the workflow from the
Actions tab with the existing tag. Leave `publish_npm` off unless the `npm`
stage is the part that failed: a version publishes to the registry only once.

**Why CI and not a local publish:** the npm account uses passkey 2FA, and
`npm publish` only falls back to the browser WebAuthn challenge inside a real
TTY. A tool-run shell is not a TTY, so a local publish dies with `EOTP`. That
is the entire reason this workflow exists; do not "simplify" it back to a local
publish.

If the workflow fails, read the run log and fix the repo. Only involve the user
for something outside the repository: npm org membership, the trusted-publisher
configuration, or a registry-side outage.

## Version policy

`package.json`'s `version` is canonical. These four files must agree, and
`release:check` fails closed if they drift:

- `package.json`
- `.claude-plugin/marketplace.json` (`metadata.version`)
- `plugins/langfuse-cli/.claude-plugin/plugin.json`
- `plugins/langfuse-cli/.codex-plugin/plugin.json`

| Change | Increment |
| --- | --- |
| Compatible fix, security fix, Skill correction | Patch |
| New user-visible capability | Minor |
| Incompatible CLI, config, or JSON output change | Major, with migration notes |
| New API snapshot that only adds commands | Minor |

The envelope's `schemaVersion` is a **separate** contract — do not bump it with
the product version.

## Invariants that must not regress

- **No `--secret-key` flag.** Secrets reach the credential store through stdin
  only, never argv, so they stay out of shell history and the process list.
- **`private` must stay absent and `publishConfig.access` must stay `public`.**
  The name must stay under `@cognelis/`; the bare `langfuse-cli` is upstream's.
- **`files` lists `dist/cli.js`, `dist/contracts`, `dist/skills` explicitly**,
  never bare `dist` — the release build writes the ~60-90 MB executables to
  `dist/`, and they belong on the GitHub release, never in the npm tarball.
- **A release binary is built on a runner of its own platform.**
  `scripts/build-release.ts build` refuses a target the host cannot execute,
  because it starts the binary it just compiled. Do not "simplify" the matrix
  into one cross-compiling job.
- **Completion is a callback, not a generated table.** The command surface
  depends on `--api-version` (22 resources on 3.50, 37 on 4.16), so a baked-in
  list would be wrong. Completion must never do network I/O or open the
  credential store.
- **Human output matches signoz-cli**: header over a dashed rule, `key: value`
  with aligned colons, trailing `Profile:` on stderr, `--output auto` giving a
  table on a TTY and the JSON envelope elsewhere.
- The zsh completion function must be named `_langfuse-cli` (hyphen), matching
  the file name zsh resolves it by. An underscored name loads silently and
  never fires.
- **Do not parse `npm pack --json` in CI.** Its envelope changed between npm 10
  (an array) and npm 12 (an object keyed by package name), and CI installs
  `npm@latest` for trusted publishing while this machine has npm 10 — so a
  locally verified script can still break the release. The tarball check reads
  `tar -tzf` instead. When verifying a workflow step locally, run it under
  `bash -c`, not the interactive zsh, or `set -euo pipefail` and globbing
  behave differently.

## Layout

- `src/contracts/` — OpenAPI → command surface compiler; the hardest part of
  the repo, inherited from upstream. 593 goldens pin its behavior.
- `src/commands/` — connection (auth/profile/config/doctor), init, skills,
  completion.
- `src/credentials.ts` — keyring backends, each fed on stdin.
- `plugins/langfuse-cli/skills/langfuse/` — canonical Skill; copied to `dist/`
  at build time and embedded in the compiled binary. Keep it in sync with real
  CLI behavior.

## Local install

```sh
bun run build && npm i -g .     # from a checkout
bun run compile ~/bin/langfuse-cli   # standalone, no Node needed
```

zsh completion goes to `~/.zsh/completions/_langfuse-cli` on this machine.
