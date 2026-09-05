// Connection management: auth, profile, config and doctor.
//
// Every command here treats the secret key as write-only: it enters through
// stdin or a masked prompt, goes straight to the credential store, and is never
// echoed, logged or included in any output. `config show` and `profile show`
// report whether a secret exists, never what it is.
import packageJson from "../../package.json";

import {
  Config,
  normalizeHost,
  resolveCredentials,
  type ResolvedConnection,
} from "../config";
import type { CredentialStore } from "../credentials";
import { CliError, EXIT_CONFIG, EXIT_USAGE } from "../errors";
import {
  CHECK_API,
  CHECK_AUTHENTICATION,
  CHECK_CONFIGURATION,
  CHECK_CREDENTIALS,
  DoctorReport,
} from "../doctor";
import {
  renderSuccess,
  writeWarnings,
  type Meta,
  type OutputMode,
} from "../output";
import { renderKeyValues, renderTable, writeContext } from "../table";
import {
  assertInteractive,
  promptSecret,
  readSecretFromStdin,
} from "../prompt";
import { checkAuth, checkHealth } from "../verify";

export interface CommandContext {
  config: Config;
  store: CredentialStore;
  outputMode: OutputMode;
  timeoutMs: number;
  environment: { host?: string; publicKey?: string; secretKey?: string };
  profileFlag?: string;
  hostFlag?: string;
  publicKeyFlag?: string;
  /** Raw flag map for command-specific options. */
  flags: Record<string, string>;
  booleans: Set<string>;
}

/**
 * Writes a command result.
 *
 * `table` supplies the human-readable layout; without one the payload is
 * pretty-printed. The trailing `Profile:` line and any warnings go to stderr,
 * so stdout stays usable even when a table is piped somewhere.
 */
function emit(
  context: CommandContext,
  command: string,
  data: unknown,
  meta: Meta = {},
  table?: () => string,
): void {
  if (context.outputMode === "table" && table) {
    const rendered = table();
    if (rendered) process.stdout.write(`${rendered}\n`);
    writeContext(meta.profile);
  } else {
    process.stdout.write(renderSuccess(context.outputMode, command, data, meta));
  }
  // JSON output keeps warnings inside meta; the human-readable form would drop
  // them entirely, so they go to stderr instead of being lost.
  if (context.outputMode === "table" && meta.warnings?.length) {
    writeWarnings(meta.warnings);
  }
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

/** Resolves the profile a connection command acts on. */
function targetProfile(context: CommandContext, positional?: string): string {
  const name = positional ?? context.profileFlag ?? context.config.currentProfile;
  if (!name) {
    throw new CliError(
      "No profile selected: pass a profile name, use --profile, or run `langfuse-cli init`",
      EXIT_CONFIG,
    );
  }
  return name;
}

async function resolveConnection(
  context: CommandContext,
): Promise<ResolvedConnection> {
  const target = context.config.resolveTarget({
    explicitHost: context.hostFlag,
    explicitPublicKey: context.publicKeyFlag,
    selectedProfile: context.profileFlag,
    environmentHost: context.environment.host,
  });
  return resolveCredentials(target, context.environment, context.store);
}

// ---------------------------------------------------------------- auth

/**
 * Stores a secret key for a profile.
 *
 * There is deliberately no `--secret-key` flag: a secret passed as an argument
 * lands in shell history and in every process listing on the machine.
 */
export async function authLogin(context: CommandContext): Promise<void> {
  const name = targetProfile(context);
  const profile = context.config.profile(name);
  if (!profile) {
    throw new CliError(
      `Profile '${name}' does not exist; create it with \`langfuse-cli profile add ${name} --host <url> --public-key <pk>\``,
      EXIT_CONFIG,
    );
  }
  const publicKey =
    context.publicKeyFlag ?? context.flags["public-key"] ?? profile.publicKey;
  if (!publicKey) {
    throw new CliError(
      `Profile '${name}' has no public key; pass --public-key`,
      EXIT_CONFIG,
    );
  }

  const secretKey = context.booleans.has("secret-key-stdin")
    ? await readSecretFromStdin()
    : (assertInteractive([
        `printf '%s' "$LANGFUSE_SECRET_KEY" | langfuse-cli auth login --profile ${name} --secret-key-stdin`,
      ]),
      await promptSecret(`Secret key for profile '${name}'`));
  if (!secretKey) {
    throw new CliError("No secret key provided", EXIT_USAGE);
  }

  const warnings: string[] = [];
  const skipVerify = context.booleans.has("no-verify");
  if (skipVerify) {
    warnings.push(
      "credentials were stored without verification (--no-verify)",
    );
  } else {
    const auth = await checkAuth(
      profile.host,
      publicKey,
      secretKey,
      context.timeoutMs,
    );
    if (!auth.ok) {
      throw new CliError(`Not stored: ${auth.message}`, EXIT_CONFIG);
    }
  }

  await context.store.set(name, secretKey);
  if (publicKey !== profile.publicKey) {
    context.config.updateProfile(name, { publicKey });
    await context.config.save();
  }
  if (!context.store.systemBacked) {
    warnings.push(
      `no system credential store was available; the secret key is in ${context.store.description}`,
    );
  }
  emit(
    context,
    "auth.login",
    { profile: name, host: profile.host, store: context.store.id, verified: !skipVerify },
    { profile: name, host: profile.host, warnings },
    () =>
      renderKeyValues([
        ["profile", name],
        ["host", profile.host],
        ["secret key", `stored (${context.store.id})`],
        ["verified", yesNo(!skipVerify)],
      ]),
  );
}

export async function authCheck(context: CommandContext): Promise<void> {
  const connection = await resolveConnection(context);
  const auth = await checkAuth(
    connection.host,
    connection.publicKey,
    connection.secretKey,
    context.timeoutMs,
  );
  if (!auth.ok) throw new CliError(auth.message, EXIT_CONFIG);
  emit(
    context,
    "auth.check",
    {
      host: connection.host,
      profile: connection.profile,
      credentialSource: connection.credentialSource,
      projects: auth.projects ?? [],
    },
    { status: auth.status, profile: connection.profile, host: connection.host },
    () =>
      renderKeyValues([
        ["host", connection.host],
        ["credentials", connection.credentialSource],
        ["projects", (auth.projects ?? []).join(", ") || "(none visible)"],
      ]),
  );
}

export async function authLogout(context: CommandContext): Promise<void> {
  const name = targetProfile(context);
  await context.store.delete(name);
  emit(
    context,
    "auth.logout",
    { profile: name },
    { profile: name },
    () => `Removed the stored secret key for '${name}'.`,
  );
}

// ------------------------------------------------------------- profile

export async function profileAdd(
  context: CommandContext,
  name: string,
): Promise<void> {
  const host = context.flags.host ?? context.hostFlag;
  const publicKey = context.flags["public-key"] ?? context.publicKeyFlag;
  if (!host) {
    throw new CliError("profile add requires --host <url>", EXIT_USAGE);
  }
  if (!publicKey) {
    throw new CliError("profile add requires --public-key <pk>", EXIT_USAGE);
  }
  context.config.addProfile(name, host, publicKey);
  await context.config.save();
  emit(
    context,
    "profile.add",
    { profile: name, host: normalizeHost(host), publicKey },
    { profile: name },
    () =>
      renderKeyValues([
        ["profile", name],
        ["host", normalizeHost(host)],
        ["public key", publicKey],
        ["secret key", "missing — run `langfuse-cli auth login`"],
      ]),
  );
}

/**
 * Changing the address invalidates the stored secret for that profile, so the
 * secret is cleared first. If it cannot be cleared the URL is left untouched,
 * which keeps a stale credential from silently pointing at a new instance.
 */
export async function profileUpdate(
  context: CommandContext,
  name: string,
): Promise<void> {
  // --host and --public-key are global options, so they are consumed before
  // subcommand parsing; here they name the new values rather than select a
  // connection.
  const host = context.flags.host ?? context.hostFlag;
  const publicKey = context.flags["public-key"] ?? context.publicKeyFlag;
  if (host === undefined && publicKey === undefined) {
    throw new CliError(
      "profile update requires --host and/or --public-key",
      EXIT_USAGE,
    );
  }
  const existing = context.config.profile(name);
  if (!existing) {
    throw new CliError(`Profile '${name}' does not exist`, EXIT_CONFIG);
  }
  const hostChanges =
    host !== undefined && normalizeHost(host) !== existing.host;
  if (hostChanges) {
    try {
      await context.store.delete(name);
    } catch (error) {
      throw new CliError(
        `Address unchanged: the stored secret key for '${name}' could not be cleared (${error instanceof Error ? error.message : String(error)})`,
        EXIT_CONFIG,
      );
    }
  }
  context.config.updateProfile(name, { host, publicKey });
  await context.config.save();
  const updated = context.config.profile(name);
  emit(
    context,
    "profile.update",
    {
      profile: name,
      host: updated?.host,
      publicKey: updated?.publicKey,
      secretCleared: hostChanges,
    },
    {
      profile: name,
      warnings: hostChanges
        ? [`the secret key for '${name}' was cleared; run \`langfuse-cli auth login --profile ${name}\``]
        : [],
    },
  );
}

export async function profileList(context: CommandContext): Promise<void> {
  const profiles = await Promise.all(
    context.config.names().map(async (name) => {
      const profile = context.config.profile(name);
      return {
        name,
        host: profile?.host ?? "",
        publicKey: profile?.publicKey ?? "",
        hasSecret: Boolean(await context.store.get(name)),
        current: name === context.config.currentProfile,
      };
    }),
  );
  if (context.outputMode === "table" && profiles.length === 0) {
    process.stdout.write("No profiles configured. Run `langfuse-cli init`.\n");
    return;
  }
  emit(
    context,
    "profile.list",
    profiles,
    { profile: context.config.currentProfile },
    () =>
      renderTable(
        ["current", "name", "host", "key"],
        profiles.map((profile) => [
          profile.current ? "*" : "",
          profile.name,
          profile.host,
          profile.hasSecret ? "stored" : "missing",
        ]),
      ),
  );
}

export async function profileShow(
  context: CommandContext,
  positional?: string,
): Promise<void> {
  const name = targetProfile(context, positional);
  const profile = context.config.profile(name);
  if (!profile) {
    throw new CliError(`Profile '${name}' does not exist`, EXIT_CONFIG);
  }
  const hasSecret = Boolean(await context.store.get(name));
  const current = name === context.config.currentProfile;
  emit(
    context,
    "profile.show",
    {
      profile: name,
      host: profile.host,
      publicKey: profile.publicKey,
      hasSecret,
      store: context.store.id,
      current,
    },
    { host: profile.host },
    () =>
      renderKeyValues([
        ["name", name],
        ["host", profile.host],
        ["public key", profile.publicKey],
        ["secret key", hasSecret ? `stored (${context.store.id})` : "missing"],
        ["current", yesNo(current)],
      ]),
  );
}

export async function profileUse(
  context: CommandContext,
  name: string,
): Promise<void> {
  context.config.useProfile(name);
  await context.config.save();
  emit(
    context,
    "profile.use",
    { profile: name },
    { profile: name },
    () => `Default profile is now '${name}'.`,
  );
}

export async function profileRemove(
  context: CommandContext,
  name: string,
): Promise<void> {
  context.config.removeProfile(name);
  await context.store.delete(name);
  await context.config.save();
  emit(
    context,
    "profile.remove",
    { profile: name, currentProfile: context.config.currentProfile ?? null },
    {},
    () =>
      `Removed profile '${name}' and its stored secret key.` +
      (context.config.currentProfile
        ? ` Default profile is now '${context.config.currentProfile}'.`
        : " No profiles remain."),
  );
}

// -------------------------------------------------------------- config

export function configPath(context: CommandContext): void {
  emit(
    context,
    "config.path",
    { path: context.config.path },
    {},
    () => context.config.path,
  );
}

/** Never includes credentials: only whether one is present. */
export async function configShow(context: CommandContext): Promise<void> {
  const profiles = await Promise.all(
    context.config.names().map(async (name) => {
      const profile = context.config.profile(name);
      return {
        name,
        host: profile?.host ?? "",
        publicKey: profile?.publicKey ?? "",
        hasSecret: Boolean(await context.store.get(name)),
      };
    }),
  );
  emit(
    context,
    "config.show",
    {
      path: context.config.path,
      currentProfile: context.config.currentProfile ?? null,
      credentialStore: { id: context.store.id, systemBacked: context.store.systemBacked },
      profiles,
    },
    {},
    () => {
      const header = renderKeyValues([
        ["path", context.config.path],
        ["current profile", context.config.currentProfile ?? "(none)"],
        [
          "credential store",
          `${context.store.id}${context.store.systemBacked ? "" : " (not system-backed)"}`,
        ],
      ]);
      if (profiles.length === 0) return `${header}\nProfiles: (none)`;
      const table = renderTable(
        ["current", "name", "host", "key"],
        profiles.map((profile) => [
          profile.name === context.config.currentProfile ? "*" : "",
          profile.name,
          profile.host,
          profile.hasSecret ? "stored" : "missing",
        ]),
      );
      return `${header}\nProfiles:\n${table}`;
    },
  );
}

// -------------------------------------------------------------- doctor

/**
 * Runs the ordered diagnosis and always writes the report before exiting with
 * the code that matches the first failure.
 */
export async function doctor(context: CommandContext): Promise<void> {
  const report = new DoctorReport(packageJson.version);

  let connection: ResolvedConnection | undefined;
  try {
    const target = context.config.resolveTarget({
      explicitHost: context.hostFlag,
      explicitPublicKey: context.publicKeyFlag,
      selectedProfile: context.profileFlag,
      environmentHost: context.environment.host,
    });
    report.pass(
      CHECK_CONFIGURATION,
      target.profile
        ? `profile '${target.profile}' -> ${target.host}`
        : `${target.host} (no profile)`,
    );
    try {
      connection = await resolveCredentials(
        target,
        context.environment,
        context.store,
      );
      report.pass(
        CHECK_CREDENTIALS,
        `public key present, secret key from ${connection.credentialSource} (${context.store.id})`,
      );
    } catch (error) {
      report.fail(
        CHECK_CREDENTIALS,
        error instanceof Error ? error.message : String(error),
      );
    }
  } catch (error) {
    report.fail(
      CHECK_CONFIGURATION,
      error instanceof Error ? error.message : String(error),
    );
  }

  const host = connection?.host ?? context.hostFlag ?? context.environment.host;
  if (host) {
    const health = await checkHealth(host, context.timeoutMs);
    if (health.ok) report.pass(CHECK_API, health.message);
    else report.fail(CHECK_API, health.message);

    if (health.ok && connection) {
      const auth = await checkAuth(
        connection.host,
        connection.publicKey,
        connection.secretKey,
        context.timeoutMs,
      );
      if (auth.ok) report.pass(CHECK_AUTHENTICATION, auth.message);
      else report.fail(CHECK_AUTHENTICATION, auth.message);
    }
  }

  const payload = report.toJSON();
  if (context.outputMode === "table") {
    process.stdout.write(`${report.render()}\n`);
    writeContext(connection?.profile);
  } else {
    process.stdout.write(
      renderSuccess(context.outputMode, "doctor", payload, {
        profile: connection?.profile,
        host: connection?.host,
      }),
    );
  }
  if (!report.healthy) process.exitCode = report.exitCode;
}
