# Maintenance

## OpenAPI contracts

Builds compile committed OpenAPI snapshots into compact versioned contracts
under ignored `dist/contracts/`. Catalog entries record the exact committed
hash; snapshots with explicit local annotations also record the upstream hash
and modification name. Generated contracts are packaged on npm but are not
committed.

```sh
# Build the Bun CLI and all versioned contracts
bun run build

# Add or refresh an immutable upstream snapshot
bun run conformance:sync -- --version <version>

# Add a stable release snapshot, update metadata, and verify it
bun run conformance:add-version -- v4.11.0
```

## Testing

The version-pinned black-box suite lives in [`conformance/`](conformance/README.md).
It invokes every operation through the real CLI across historical Langfuse
specs. Active operations make one minimally valid mocked API call; operations
marked `deprecated: true` must fail before any network request.

```sh
bun test
bun run conformance:all
```

`bun test` verifies the generator, schemas, serialization, capture oracle,
deprecation policy, and legacy CLI compatibility. `bun run conformance:all`
builds the package and checks every operation through the native CLI using its
lossless JSON input path. CI runs both.

## Command goldens and overrides

The user-facing command surface (resource, action, aliases, deprecation) of
every snapshot is pinned in reviewed goldens under `conformance/goldens/`.
Tests and the build fail when compiled names differ from the goldens, so a
change to the naming heuristics cannot silently rename commands. After an
intentional naming change, regenerate and review the diff:

```sh
bun run goldens:update
```

All option flags are derived mechanically: query/header parameters and
request-body fields kebab-case their wire names (`objectId` -> `--object-id`),
so new spec versions get flags without per-parameter maintenance. The
compiler validates each operation's full flag namespace (parameters, aliases,
body fields, reserved and global flags) and fails the build when a new
snapshot introduces a collision, instead of silently shipping a dead or
hijacked flag.

Hand-written naming exceptions live in `src/contracts/overrides.json` and are
applied by the contract compiler, never hardcoded in the runtime: extra
parameter flag spellings (`parameterFlagAliases`, e.g. `--prompt-version`),
body-field flag renames for collisions (`bodyFieldFlags`, e.g.
`llmConnections_upsert.secretKey` -> `--provider-secret-key` because
`--secret-key` is a removed name that argument parsing intercepts to report its
replacement), and per-version command overrides.
A snapshot that lacks the referenced parameter or field skips the entry, but
an entry applied in no snapshot at all fails the build, tests, and
`goldens:update`, so stale overrides cannot rot silently.

## Version policy

`package.json`'s `version` is the canonical product version. The three plugin
manifests — `.claude-plugin/marketplace.json` (as `metadata.version`) and both
`plugins/langfuse-cli/.*-plugin/plugin.json` — must carry the same version.

Use plain `MAJOR.MINOR.PATCH`:

| Change | Version increment |
| --- | --- |
| Compatible bug fix, security fix, or bundled Skill correction | Patch |
| New user-visible capability | Minor |
| Incompatible CLI, config, or JSON output change | Major, with migration notes |
| New bundled API snapshot that only adds commands | Minor |
| Internal refactor, tests, or documentation with no shipped behavior change | Record under Unreleased when useful; no standalone release is required |

Choose the highest required increment in a batch, and bump once for the
completed batch rather than for each intermediate edit.

The JSON envelope's `schemaVersion` is a **separate compatibility contract**.
Do not change it just because the product version changes; describe breaking
behavior and the required caller changes in the changelog instead.

## Record changes as you work

Add concise, user-facing entries under `CHANGELOG.md`'s `Unreleased` section
using `Added`, `Changed`, `Fixed`, `Removed`, or `Security`. Include migration
notes whenever commands, authentication, defaults, or output contracts change.
Do not rewrite a published entry to hide a later change.

Keep CLI behavior, README examples, and the bundled Skill at
`plugins/langfuse-cli/skills/langfuse/SKILL.md` in sync. The Skill is copied
into `dist/` at build time and embedded in the compiled executable, so rebuild
before updating installed copies with `skills install`.

## Cutting a version

```sh
bun run release:check
```

It verifies that the version is a plain semver triple, that `private` is still
set, that all four manifests agree, and that `CHANGELOG.md` records the version
with a date and lists releases newest-first. It rejects duplicates and
out-of-order entries. **It does not commit, tag, push, publish, or install
anything** — that decision stays with a human.

Run the full gates before finalizing:

```sh
bun run typecheck
bun test
bun run conformance:all
bun run compile          # optional: verify the standalone executable
```

## This fork does not publish to npm

`package.json` carries `"private": true` and `release.yml` was removed. The
package name `langfuse-cli` belongs to upstream; publishing from this fork would
either fail or, worse, contend for that name. Install locally instead:

```sh
bun run build && npm i -g .
# or a standalone binary:
bun run compile ~/bin/langfuse-cli
```

Agents consume the CLI through `skills install` or the plugin marketplace, not
through a registry.
