// Secret-key storage backed by the operating-system credential store.
//
// The CLI keeps zero runtime dependencies, so every backend shells out to a
// tool that ships with the platform instead of linking a native module. Each
// backend receives the secret on stdin: an argv-borne secret would be visible
// to any process that can read the process list, which is exactly the exposure
// this module exists to remove.
//
// Only the secret key is stored here. The public key and host live in the
// config file, where they stay reviewable.
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { CliError, EXIT_CONFIG } from "./errors";

export const CREDENTIAL_SERVICE = "langfuse-cli";

export interface CredentialStore {
  /** Stable identifier reported by `doctor` and `config show`. */
  readonly id: string;
  /** Human-readable backend name for diagnostics. */
  readonly description: string;
  /** True when secrets are protected by the operating system rather than a file. */
  readonly systemBacked: boolean;
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<void>;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCommand(
  command: string,
  args: string[],
  stdin?: string,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
    // A backend that never reads stdin closes the pipe first; that EPIPE is
    // expected and must not surface as a failure.
    child.stdin.on("error", () => {});
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

async function commandExists(command: string): Promise<boolean> {
  try {
    const probe = await runCommand(
      process.platform === "win32" ? "where" : "which",
      [command],
    );
    return probe.code === 0;
  } catch {
    return false;
  }
}

// macOS: the login keychain via `security`. `-w` without a value reads the
// secret from stdin, prompting twice, so the value is fed twice.
const macosKeychain: CredentialStore = {
  id: "macos-keychain",
  description: "macOS login keychain (security)",
  systemBacked: true,

  async get(account) {
    const result = await runCommand("security", [
      "find-generic-password",
      "-a",
      account,
      "-s",
      CREDENTIAL_SERVICE,
      "-w",
    ]);
    if (result.code !== 0) return null;
    const secret = result.stdout.replace(/\n$/, "");
    return secret.length > 0 ? secret : null;
  },

  async set(account, secret) {
    const result = await runCommand(
      "security",
      [
        "add-generic-password",
        "-a",
        account,
        "-s",
        CREDENTIAL_SERVICE,
        "-U",
        "-w",
      ],
      `${secret}\n${secret}\n`,
    );
    if (result.code !== 0) {
      throw new CliError(
        `Cannot store the secret key in the macOS keychain: ${result.stderr.trim() || `exit ${result.code}`}`,
        EXIT_CONFIG,
      );
    }
  },

  async delete(account) {
    const result = await runCommand("security", [
      "delete-generic-password",
      "-a",
      account,
      "-s",
      CREDENTIAL_SERVICE,
    ]);
    // Exit 44 is "item not found", which makes deletion idempotent.
    if (result.code !== 0 && result.code !== 44) {
      const detail = result.stderr.trim();
      if (!/could not be found/i.test(detail)) {
        throw new CliError(
          `Cannot remove the secret key from the macOS keychain: ${detail || `exit ${result.code}`}`,
          EXIT_CONFIG,
        );
      }
    }
  },
};

// Linux: libsecret via `secret-tool`, which reads the secret from stdin.
const libsecret: CredentialStore = {
  id: "libsecret",
  description: "Freedesktop secret service (secret-tool)",
  systemBacked: true,

  async get(account) {
    const result = await runCommand("secret-tool", [
      "lookup",
      "service",
      CREDENTIAL_SERVICE,
      "account",
      account,
    ]);
    if (result.code !== 0) return null;
    const secret = result.stdout.replace(/\n$/, "");
    return secret.length > 0 ? secret : null;
  },

  async set(account, secret) {
    const result = await runCommand(
      "secret-tool",
      [
        "store",
        "--label",
        `${CREDENTIAL_SERVICE} (${account})`,
        "service",
        CREDENTIAL_SERVICE,
        "account",
        account,
      ],
      secret,
    );
    if (result.code !== 0) {
      throw new CliError(
        `Cannot store the secret key in the secret service: ${result.stderr.trim() || `exit ${result.code}`}`,
        EXIT_CONFIG,
      );
    }
  },

  async delete(account) {
    await runCommand("secret-tool", [
      "clear",
      "service",
      CREDENTIAL_SERVICE,
      "account",
      account,
    ]);
  },
};

// Windows: DPAPI through PowerShell. ConvertFrom-SecureString encrypts against
// the current user account, so the ciphertext is useless to other users.
function windowsVaultPath(account: string): string {
  return join(windowsVaultDirectory(), `${encodeURIComponent(account)}.dpapi`);
}

function windowsVaultDirectory(): string {
  const base =
    process.env.APPDATA ??
    join(process.env.USERPROFILE ?? ".", "AppData", "Roaming");
  return join(base, "langfuse-cli", "credentials");
}

const windowsDpapi: CredentialStore = {
  id: "windows-dpapi",
  description: "Windows DPAPI (PowerShell, per-user encryption)",
  systemBacked: true,

  async get(account) {
    const path = windowsVaultPath(account);
    const result = await runCommand("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `if (-not (Test-Path -LiteralPath $env:LF_VAULT)) { exit 44 }; ` +
        `$secure = Get-Content -LiteralPath $env:LF_VAULT | ConvertTo-SecureString; ` +
        `[Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))`,
    ]);
    if (result.code !== 0) return null;
    const secret = result.stdout.replace(/\r?\n$/, "");
    return secret.length > 0 ? secret : null;
  },

  async set(account, secret) {
    await mkdir(windowsVaultDirectory(), { recursive: true });
    const result = await runCommand(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$plain = [Console]::In.ReadToEnd().TrimEnd("\`r","\`n"); ` +
          `ConvertTo-SecureString -String $plain -AsPlainText -Force | ` +
          `ConvertFrom-SecureString | Set-Content -LiteralPath $env:LF_VAULT -NoNewline`,
      ],
      secret,
    );
    if (result.code !== 0) {
      throw new CliError(
        `Cannot store the secret key with DPAPI: ${result.stderr.trim() || `exit ${result.code}`}`,
        EXIT_CONFIG,
      );
    }
  },

  async delete(account) {
    await rm(windowsVaultPath(account), { force: true });
  },
};

// Last resort: a 0600 file. Chosen only when no system store is reachable, and
// every command that relies on it reports the downgrade.
export function fileStore(path: string): CredentialStore {
  const read = async (): Promise<Record<string, string>> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }
      return parsed as Record<string, string>;
    } catch {
      return {};
    }
  };
  const write = async (entries: Record<string, string>): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(entries, null, 2)}\n`, {
      mode: 0o600,
    });
    await chmod(path, 0o600);
  };
  return {
    id: "file",
    description: `plaintext file with 0600 permissions (${path})`,
    systemBacked: false,
    async get(account) {
      return (await read())[account] ?? null;
    },
    async set(account, secret) {
      const entries = await read();
      entries[account] = secret;
      await write(entries);
    },
    async delete(account) {
      const entries = await read();
      delete entries[account];
      await write(entries);
    },
  };
}

// The Windows backend passes the vault path through the environment so the
// account name never lands inside a PowerShell command string.
function withWindowsVaultEnv(account: string): CredentialStore {
  const path = windowsVaultPath(account);
  const wrap = async <T>(action: () => Promise<T>): Promise<T> => {
    const previous = process.env.LF_VAULT;
    process.env.LF_VAULT = path;
    try {
      return await action();
    } finally {
      if (previous === undefined) delete process.env.LF_VAULT;
      else process.env.LF_VAULT = previous;
    }
  };
  return {
    id: windowsDpapi.id,
    description: windowsDpapi.description,
    systemBacked: windowsDpapi.systemBacked,
    get: (name) => wrap(() => windowsDpapi.get(name)),
    set: (name, secret) => wrap(() => windowsDpapi.set(name, secret)),
    delete: (name) => wrap(() => windowsDpapi.delete(name)),
  };
}

const windowsStore: CredentialStore = {
  id: windowsDpapi.id,
  description: windowsDpapi.description,
  systemBacked: windowsDpapi.systemBacked,
  get: (account) => withWindowsVaultEnv(account).get(account),
  set: (account, secret) => withWindowsVaultEnv(account).set(account, secret),
  delete: (account) => withWindowsVaultEnv(account).delete(account),
};

export interface CredentialStoreOptions {
  /** Fallback path used when no system credential store is reachable. */
  fallbackPath: string;
  /** Force the file backend, for tests and for hosts without a keyring. */
  forceFile?: boolean;
}

export async function resolveCredentialStore(
  options: CredentialStoreOptions,
): Promise<CredentialStore> {
  if (options.forceFile) return fileStore(options.fallbackPath);
  if (process.platform === "darwin" && (await commandExists("security"))) {
    return macosKeychain;
  }
  if (process.platform === "linux" && (await commandExists("secret-tool"))) {
    return libsecret;
  }
  if (process.platform === "win32" && (await commandExists("powershell"))) {
    return windowsStore;
  }
  return fileStore(options.fallbackPath);
}
