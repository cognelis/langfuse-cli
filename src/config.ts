// Profile storage and connection resolution.
//
// A profile records only the host and the public key. The secret key lives in
// the operating-system credential store (see credentials.ts), so this file
// stays reviewable and can be copied between machines without leaking access.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { CredentialStore } from "./credentials";
import { CliError, EXIT_CONFIG } from "./errors";

export const DEFAULT_HOST = "https://cloud.langfuse.com";

export interface ProfileConfig {
  host: string;
  publicKey: string;
}

export interface ConfigData {
  currentProfile?: string;
  profiles: Record<string, ProfileConfig>;
}

/** Where the secret key for a resolved connection came from. */
export type CredentialSource = "environment" | "profile" | "flag";

export interface ResolvedConnection {
  host: string;
  publicKey: string;
  secretKey: string;
  profile?: string;
  credentialSource: CredentialSource;
}

/** A connection target before its secret key has been looked up. */
export interface ResolvedTarget {
  host: string;
  publicKey?: string;
  profile?: string;
  /** Set when the target must take its credentials from the environment. */
  environmentOnly?: { missingMessage: string };
}

const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function configDirectory(): string {
  if (process.platform === "win32") {
    const base =
      process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(base, "langfuse-cli");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "langfuse-cli");
  }
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "langfuse-cli");
}

export function defaultConfigPath(): string {
  return join(configDirectory(), "config.json");
}

/** Credentials live beside the config file they belong to. */
export function fallbackCredentialPath(configPath?: string): string {
  return configPath
    ? join(dirname(configPath), "credentials.json")
    : join(configDirectory(), "credentials.json");
}

export function normalizeHost(host: string): string {
  const trimmed = host.trim().replace(/\/+$/, "");
  if (!trimmed) throw new CliError("Host must not be empty", EXIT_CONFIG);
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new CliError(
      `Invalid host URL: ${host} (include the scheme, for example https://cloud.langfuse.com)`,
      EXIT_CONFIG,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CliError(
      `Unsupported host scheme: ${parsed.protocol.replace(":", "")}`,
      EXIT_CONFIG,
    );
  }
  return trimmed;
}

export function assertProfileName(name: string): void {
  if (!PROFILE_NAME_PATTERN.test(name)) {
    throw new CliError(
      `Invalid profile name: ${name} (letters, digits, dot, dash and underscore; must not start with a separator)`,
      EXIT_CONFIG,
    );
  }
}

export class Config {
  constructor(
    readonly path: string,
    private data: ConfigData,
  ) {}

  static empty(path: string): Config {
    return new Config(path, { profiles: {} });
  }

  /**
   * Reads the config file. A missing file yields an empty config so first-run
   * commands work; a malformed file is reported so `config path` and the repair
   * flows can still tell the user what to fix.
   */
  static async load(path: string): Promise<Config> {
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return Config.empty(path);
      }
      throw new CliError(
        `Cannot read the config file ${path}: ${error instanceof Error ? error.message : String(error)}`,
        EXIT_CONFIG,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      throw new CliError(
        `The config file ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        EXIT_CONFIG,
      );
    }
    return new Config(path, normalizeData(parsed));
  }

  get profiles(): Record<string, ProfileConfig> {
    return this.data.profiles;
  }

  get currentProfile(): string | undefined {
    return this.data.currentProfile;
  }

  profile(name: string): ProfileConfig | undefined {
    return this.data.profiles[name];
  }

  names(): string[] {
    return Object.keys(this.data.profiles).sort();
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(this.data, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  addProfile(name: string, host: string, publicKey: string): void {
    assertProfileName(name);
    if (this.data.profiles[name]) {
      throw new CliError(`Profile '${name}' already exists`, EXIT_CONFIG);
    }
    this.data.profiles[name] = {
      host: normalizeHost(host),
      publicKey: publicKey.trim(),
    };
    this.data.currentProfile ??= name;
  }

  /**
   * Updates a profile in place. Pointing a profile at a different instance
   * invalidates its stored secret, so the caller is told to clear it before the
   * new address is saved.
   */
  updateProfile(
    name: string,
    changes: { host?: string; publicKey?: string },
  ): { hostChanged: boolean } {
    const existing = this.data.profiles[name];
    if (!existing) {
      throw new CliError(`Profile '${name}' does not exist`, EXIT_CONFIG);
    }
    const nextHost =
      changes.host === undefined ? existing.host : normalizeHost(changes.host);
    const hostChanged = nextHost !== existing.host;
    this.data.profiles[name] = {
      host: nextHost,
      publicKey:
        changes.publicKey === undefined
          ? existing.publicKey
          : changes.publicKey.trim(),
    };
    return { hostChanged };
  }

  useProfile(name: string): void {
    if (!this.data.profiles[name]) {
      throw new CliError(`Profile '${name}' does not exist`, EXIT_CONFIG);
    }
    this.data.currentProfile = name;
  }

  removeProfile(name: string): void {
    if (!this.data.profiles[name]) {
      throw new CliError(`Profile '${name}' does not exist`, EXIT_CONFIG);
    }
    delete this.data.profiles[name];
    if (this.data.currentProfile === name) {
      this.data.currentProfile = this.names()[0];
    }
  }

  /**
   * Resolves which instance a command talks to, without touching secrets.
   *
   * Order: explicit --host, then --profile, then LANGFUSE_HOST/BASE_URL, then
   * the default profile. An explicit host or an environment host takes its
   * credentials from the environment, so a stray profile can never silently
   * supply a key for an address the user typed by hand.
   */
  resolveTarget(inputs: {
    explicitHost?: string;
    explicitPublicKey?: string;
    selectedProfile?: string;
    environmentHost?: string;
  }): ResolvedTarget {
    if (inputs.explicitHost) {
      return {
        host: normalizeHost(inputs.explicitHost),
        publicKey: inputs.explicitPublicKey,
        environmentOnly: {
          missingMessage:
            "LANGFUSE_SECRET_KEY is required with --host (set it in the environment or use --secret-key-stdin)",
        },
      };
    }
    if (inputs.selectedProfile) {
      return this.profileTarget(inputs.selectedProfile, inputs.explicitPublicKey);
    }
    if (inputs.environmentHost) {
      return {
        host: normalizeHost(inputs.environmentHost),
        publicKey: inputs.explicitPublicKey,
        environmentOnly: {
          missingMessage:
            "LANGFUSE_SECRET_KEY is required with LANGFUSE_HOST",
        },
      };
    }
    if (!this.data.currentProfile) {
      throw new CliError(
        "No connection configured: run `langfuse-cli init`, or set LANGFUSE_HOST with LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY",
        EXIT_CONFIG,
      );
    }
    return this.profileTarget(this.data.currentProfile, inputs.explicitPublicKey);
  }

  private profileTarget(
    name: string,
    explicitPublicKey?: string,
  ): ResolvedTarget {
    const profile = this.data.profiles[name];
    if (!profile) {
      throw new CliError(`Profile '${name}' does not exist`, EXIT_CONFIG);
    }
    return {
      host: profile.host,
      publicKey: explicitPublicKey ?? profile.publicKey,
      profile: name,
    };
  }
}

/**
 * Attaches a secret key to a resolved target.
 *
 * The environment always wins over a stored profile secret so CI can override a
 * workstation profile without rewriting it.
 */
export async function resolveCredentials(
  target: ResolvedTarget,
  environment: { publicKey?: string; secretKey?: string },
  store: CredentialStore,
): Promise<ResolvedConnection> {
  const publicKey = target.publicKey ?? environment.publicKey;
  if (!publicKey) {
    throw new CliError(
      target.profile
        ? `Profile '${target.profile}' has no public key; run \`langfuse-cli auth login --profile ${target.profile}\``
        : "LANGFUSE_PUBLIC_KEY is required (or pass --public-key)",
      EXIT_CONFIG,
    );
  }
  if (target.environmentOnly) {
    const secretKey = environment.secretKey;
    if (!secretKey) {
      throw new CliError(target.environmentOnly.missingMessage, EXIT_CONFIG);
    }
    return {
      host: target.host,
      publicKey,
      secretKey,
      credentialSource: "environment",
    };
  }
  const profile = target.profile;
  if (!profile) {
    throw new CliError(
      "No connection configured: run `langfuse-cli init`",
      EXIT_CONFIG,
    );
  }
  if (environment.secretKey) {
    return {
      host: target.host,
      publicKey,
      secretKey: environment.secretKey,
      profile,
      credentialSource: "environment",
    };
  }
  const stored = await store.get(profile);
  if (!stored) {
    throw new CliError(
      `Profile '${profile}' has no stored secret key; run \`langfuse-cli auth login --profile ${profile}\``,
      EXIT_CONFIG,
    );
  }
  return {
    host: target.host,
    publicKey,
    secretKey: stored,
    profile,
    credentialSource: "profile",
  };
}

function normalizeData(parsed: unknown): ConfigData {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { profiles: {} };
  }
  const source = parsed as Record<string, unknown>;
  const rawProfiles =
    source.profiles && typeof source.profiles === "object" && !Array.isArray(source.profiles)
      ? (source.profiles as Record<string, unknown>)
      : {};
  const profiles: Record<string, ProfileConfig> = {};
  for (const [name, value] of Object.entries(rawProfiles)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const host = typeof entry.host === "string" ? entry.host : undefined;
    if (!host) continue;
    profiles[name] = {
      host: host.replace(/\/+$/, ""),
      publicKey: typeof entry.publicKey === "string" ? entry.publicKey : "",
    };
  }
  const currentProfile =
    typeof source.currentProfile === "string" && profiles[source.currentProfile]
      ? source.currentProfile
      : Object.keys(profiles)[0];
  return currentProfile ? { currentProfile, profiles } : { profiles };
}
