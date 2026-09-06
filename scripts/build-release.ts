// Builds and verifies the standalone executables a GitHub release ships, then
// assembles them into a checksummed asset set.
//
// `build --target <bun-triplet>` refuses to run unless the host platform and
// architecture match the target. That restriction is the point of building one
// platform per runner: the binary is *executed* before it is published, so a
// release never carries an artifact nobody has started. Each build writes the
// executable plus a small JSON manifest recording the version, target, size and
// SHA-256.
//
// `assemble` collects those manifests on one runner, re-hashes every binary and
// fails unless all of them describe the same product version — a stale artifact
// from an earlier run therefore cannot slip into a release. It then writes
// checksums.txt, LICENSE and notes.md beside the binaries, which is exactly the
// set `gh release upload` publishes.
//
// Nothing here tags, pushes or publishes. The npm package is built separately
// by scripts/build.ts and never contains these executables.
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

interface TargetInfo {
  /** process.platform of a runner that can execute the result. */
  platform: NodeJS.Platform;
  /** process.arch of that runner. */
  arch: string;
  /** Published asset name. */
  asset: string;
}

/** Bun compile triplet -> the runner that must build it and the asset it becomes. */
const TARGETS: Record<string, TargetInfo> = {
  "bun-darwin-arm64": { platform: "darwin", arch: "arm64", asset: "langfuse-cli-darwin-arm64" },
  "bun-darwin-x64": { platform: "darwin", arch: "x64", asset: "langfuse-cli-darwin-amd64" },
  "bun-linux-arm64": { platform: "linux", arch: "arm64", asset: "langfuse-cli-linux-arm64" },
  "bun-linux-x64": { platform: "linux", arch: "x64", asset: "langfuse-cli-linux-amd64" },
  "bun-windows-arm64": { platform: "win32", arch: "arm64", asset: "langfuse-cli-windows-arm64.exe" },
  "bun-windows-x64": { platform: "win32", arch: "x64", asset: "langfuse-cli-windows-amd64.exe" },
};

/** A Bun executable is ~60-90 MB; anything outside this range is a build fault. */
const MIN_SIZE = 16 * 1024 * 1024;
const MAX_SIZE = 192 * 1024 * 1024;

interface AssetManifest {
  version: string;
  target: string;
  asset: string;
  sha256: string;
  size: number;
}

function fail(message: string): never {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(1);
}

async function readJson(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function digest(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

/** package.json is the canonical product version; release:check pins the rest to it. */
async function productVersion(): Promise<string> {
  const manifest = await readJson(resolve(root, "package.json"));
  const version = String(manifest.version ?? "");
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    fail(`package.json version "${version}" is not a plain MAJOR.MINOR.PATCH version`);
  }
  return version;
}

/** owner/repo from package.json, so release notes can link to their own assets. */
async function repositorySlug(): Promise<string> {
  const manifest = await readJson(resolve(root, "package.json"));
  const url = String(manifest.repository?.url ?? "");
  const match = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
  if (!match) fail(`package.json repository.url "${url}" is not a GitHub URL`);
  return match[1]!;
}

/**
 * The changelog body for one version, taken from the section between its
 * heading and the next one. `## [Unreleased]` is skipped, and the requested
 * version must be the newest dated entry — the same shape release:check
 * enforces, re-checked here so a release cannot ship someone else's notes.
 */
async function changelogNotes(version: string): Promise<string> {
  const changelog = await readFile(resolve(root, "CHANGELOG.md"), "utf8");
  const headings = [...changelog.matchAll(/^## \[([^\]\n]+)\](?: - (\S+))?[^\n]*$/gm)];
  if (headings[0]?.[1] !== "Unreleased") {
    fail("CHANGELOG.md must start with an `## [Unreleased]` section");
  }
  const latest = headings[1];
  if (!latest || latest[1] !== version) {
    fail(`CHANGELOG.md's newest release is ${latest?.[1] ?? "missing"}, expected ${version}`);
  }
  if (!latest[2]) fail(`CHANGELOG.md entry for ${version} has no date`);
  const start = latest.index + latest[0].length;
  const end = headings[2] ? headings[2].index : changelog.length;
  const body = changelog.slice(start, end).trim();
  if (!/^- \S/m.test(body)) fail(`CHANGELOG.md entry for ${version} has no change entries`);
  return body;
}

interface SmokeResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs the freshly built binary with the ambient Langfuse configuration removed:
 * HOME, APPDATA and XDG_CONFIG_HOME point at an empty directory and every
 * LANGFUSE_* variable is dropped, so the checks below cannot accidentally read a
 * maintainer's profile or reach a real deployment.
 */
function smokeRunner(binary: string, sandbox: string) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("LANGFUSE_")) continue;
    env[key] = value;
  }
  env.HOME = sandbox;
  env.USERPROFILE = sandbox;
  env.APPDATA = sandbox;
  env.XDG_CONFIG_HOME = sandbox;

  return (args: string[]): SmokeResult => {
    const result = Bun.spawnSync([binary, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const decoder = new TextDecoder();
    return {
      status: result.exitCode ?? -1,
      stdout: decoder.decode(result.stdout),
      stderr: decoder.decode(result.stderr),
    };
  };
}

/**
 * Five offline checks, each covering a documented contract: the reported
 * version, the API command surface, the completion function name zsh resolves
 * the file by, the completion callback that replaces a baked-in command table,
 * and the usage exit code with a clean stdout.
 */
function smokeTest(binary: string, version: string, sandbox: string): void {
  const run = smokeRunner(binary, sandbox);

  const reported = run(["--version"]);
  if (reported.status !== 0 || reported.stdout.trim() !== version) {
    fail(`binary reports "${reported.stdout.trim()}" (exit ${reported.status}), expected ${version}`);
  }

  const help = run(["api", "help"]);
  if (help.status !== 0 || help.stdout.trim().length === 0) {
    fail(`\`api help\` exited ${help.status} with ${help.stdout.length} bytes of output`);
  }

  const completion = run(["completion", "zsh"]);
  if (completion.status !== 0 || !/^_langfuse-cli\b/m.test(completion.stdout)) {
    fail("`completion zsh` did not define the _langfuse-cli function zsh loads the file by");
  }

  const callback = run(["__complete", "api", "prompts"]);
  if (callback.status !== 0 || !/^list\b/m.test(callback.stdout)) {
    fail("`__complete api prompts` did not offer the list action");
  }

  const usage = run(["api", "nosuchresource"]);
  if (usage.status !== 2 || usage.stdout.length !== 0 || usage.stderr.trim().length === 0) {
    fail(
      `an unknown resource exited ${usage.status} with ${usage.stdout.length} bytes on stdout; ` +
        "expected exit 2, an empty stdout and a diagnostic on stderr",
    );
  }
}

async function build(target: string, output: string): Promise<void> {
  const info = TARGETS[target];
  if (!info) fail(`unknown target ${target}; expected one of ${Object.keys(TARGETS).join(", ")}`);
  if (process.platform !== info.platform || process.arch !== info.arch) {
    fail(
      `${target} must be built on ${info.platform}/${info.arch} so the binary can be smoke-tested, ` +
        `not on ${process.platform}/${process.arch}`,
    );
  }
  const version = await productVersion();

  await mkdir(output, { recursive: true });
  const destination = join(output, info.asset);
  await rm(destination, { force: true });

  // Rebuild the contracts and the bundled Skill first: compile.ts embeds
  // whatever dist/ holds, so a stale directory would silently ship the wrong
  // command surface.
  const built = Bun.spawnSync(["bun", resolve(root, "scripts/build.ts")], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (built.exitCode !== 0) fail("building the contracts failed");

  const compiled = Bun.spawnSync(
    ["bun", resolve(root, "scripts/compile.ts"), destination, "--target", target],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  );
  if (compiled.exitCode !== 0) fail(`compiling ${target} failed`);
  // Bun appends .exe on Windows when the name lacks it; the manifest and the
  // published asset must agree on one spelling.
  if (!(await Bun.file(destination).exists()) && (await Bun.file(`${destination}.exe`).exists())) {
    await rename(`${destination}.exe`, destination);
  }
  if (!(await Bun.file(destination).exists())) fail(`compiling ${target} produced no ${info.asset}`);

  const sandbox = await mkdtemp(join(tmpdir(), "langfuse-release-"));
  try {
    smokeTest(destination, version, sandbox);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }

  const size = (await Bun.file(destination).stat()).size;
  if (size < MIN_SIZE || size > MAX_SIZE) fail(`${info.asset} is ${size} bytes, which is out of range`);
  const manifest: AssetManifest = { version, target, asset: info.asset, sha256: await digest(destination), size };
  await writeFile(join(output, `${info.asset}.json`), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  process.stdout.write(
    `Built and verified ${info.asset} (${(size / 1024 / 1024).toFixed(1)} MB, ${version})\n`,
  );
}

async function assemble(input: string, output: string): Promise<void> {
  const version = await productVersion();
  const notes = await changelogNotes(version);
  const slug = await repositorySlug();

  const assets: Array<{ asset: string; sha256: string }> = [];
  for (const [target, info] of Object.entries(TARGETS)) {
    const binary = join(input, info.asset);
    if (!(await Bun.file(binary).exists())) fail(`missing release artifact ${info.asset}`);
    let manifest: AssetManifest;
    try {
      manifest = (await readJson(join(input, `${info.asset}.json`))) as AssetManifest;
    } catch {
      fail(`missing release manifest for ${info.asset}`);
    }
    if (manifest.version !== version || manifest.target !== target || manifest.asset !== info.asset) {
      fail(
        `release metadata mismatch for ${info.asset}: ${manifest.target}@${manifest.version} ` +
          `does not describe ${target}@${version}`,
      );
    }
    const size = (await Bun.file(binary).stat()).size;
    if (size !== manifest.size) fail(`${info.asset} is ${size} bytes, manifest says ${manifest.size}`);
    const sha256 = await digest(binary);
    if (sha256 !== manifest.sha256) fail(`${info.asset} does not match its recorded SHA-256`);
    assets.push({ asset: info.asset, sha256 });
  }

  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  for (const { asset } of assets) {
    await Bun.write(join(output, asset), Bun.file(join(input, asset)));
  }
  assets.sort((a, b) => a.asset.localeCompare(b.asset));
  await writeFile(
    join(output, "checksums.txt"),
    assets.map(({ asset, sha256 }) => `${sha256}  ${asset}\n`).join(""),
    "utf8",
  );
  await Bun.write(join(output, "LICENSE"), Bun.file(resolve(root, "LICENSE")));

  const download = `https://github.com/${slug}/releases/download/v${version}`;
  await writeFile(
    join(output, "notes.md"),
    `${notes}

## Install

\`\`\`sh
npm i -g @cognelis/langfuse-cli@${version}
\`\`\`

Or take the standalone executable for your platform. It embeds every bundled API
contract and needs no Node installation:

\`\`\`sh
curl -fsSL -o langfuse-cli ${download}/langfuse-cli-darwin-arm64
chmod +x langfuse-cli && ./langfuse-cli --version
\`\`\`

Each binary was built and smoke-tested on a runner of its own platform. Verify a
download against \`checksums.txt\`:

\`\`\`sh
shasum -a 256 --ignore-missing -c checksums.txt
\`\`\`
`,
    "utf8",
  );

  process.stdout.write(`Assembled ${assets.length} verified platforms for ${version}\n`);
}

const [command, ...rest] = process.argv.slice(2);
const options = new Map<string, string>();
for (let index = 0; index < rest.length; index++) {
  const argument = rest[index]!;
  if (!argument.startsWith("--")) fail(`unexpected argument: ${argument}`);
  const [key, inline] = argument.includes("=")
    ? [argument.slice(2, argument.indexOf("=")), argument.slice(argument.indexOf("=") + 1)]
    : [argument.slice(2), rest[++index]];
  if (inline === undefined) fail(`--${key} requires a value`);
  options.set(key, inline);
}

if (command === "build") {
  const target = options.get("target");
  if (!target) fail("build requires --target");
  await build(target, resolve(root, options.get("output") ?? "dist/artifacts"));
} else if (command === "assemble") {
  await assemble(
    resolve(root, options.get("input") ?? "dist/artifacts"),
    resolve(root, options.get("output") ?? "dist/release"),
  );
} else {
  process.stderr.write(
    "Usage:\n" +
      "  bun scripts/build-release.ts build --target <bun-triplet> [--output dist/artifacts]\n" +
      "  bun scripts/build-release.ts assemble [--input dist/artifacts] [--output dist/release]\n\n" +
      `Targets: ${Object.keys(TARGETS).join(", ")}\n`,
  );
  process.exit(command === undefined ? 1 : 2);
}
