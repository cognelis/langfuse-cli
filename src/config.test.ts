import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Config,
  normalizeHost,
  resolveCredentials,
  fallbackCredentialPath,
} from "./config";
import { fileStore, type CredentialStore } from "./credentials";
import { CliError } from "./errors";

const HOST = "https://langfuse.example.com";

function configWith(profiles: Record<string, { host: string; publicKey: string }>, current?: string) {
  const config = Config.empty("/tmp/does-not-exist/config.json");
  for (const [name, profile] of Object.entries(profiles)) {
    config.addProfile(name, profile.host, profile.publicKey);
  }
  if (current) config.useProfile(current);
  return config;
}

/** Records every account looked up, to prove when the store is not consulted. */
function trackingStore(entries: Record<string, string> = {}): CredentialStore & {
  reads: string[];
} {
  const reads: string[] = [];
  return {
    id: "test",
    description: "test store",
    systemBacked: true,
    reads,
    async get(account) {
      reads.push(account);
      return entries[account] ?? null;
    },
    async set(account, secret) {
      entries[account] = secret;
    },
    async delete(account) {
      delete entries[account];
    },
  };
}

describe("host normalization", () => {
  test("strips trailing slashes and keeps the scheme", () => {
    expect(normalizeHost("https://a.example.com///")).toBe("https://a.example.com");
  });

  test("rejects a URL without a scheme", () => {
    expect(() => normalizeHost("langfuse.example.com")).toThrow("Invalid host URL");
  });

  test("rejects a non-http scheme", () => {
    expect(() => normalizeHost("ftp://a.example.com")).toThrow("Unsupported host scheme");
  });
});

describe("profile storage", () => {
  test("the first profile added becomes current", () => {
    const config = configWith({ a: { host: HOST, publicKey: "pk-a" } });
    expect(config.currentProfile).toBe("a");
  });

  test("adding a duplicate name fails", () => {
    const config = configWith({ a: { host: HOST, publicKey: "pk-a" } });
    expect(() => config.addProfile("a", HOST, "pk-a")).toThrow("already exists");
  });

  test("a profile name with a path separator is rejected", () => {
    const config = Config.empty("/tmp/x.json");
    expect(() => config.addProfile("../escape", HOST, "pk")).toThrow(
      "Invalid profile name",
    );
  });

  test("changing the host is reported so the caller can clear the secret", () => {
    const config = configWith({ a: { host: HOST, publicKey: "pk-a" } });
    expect(config.updateProfile("a", { host: "https://other.example.com" }))
      .toEqual({ hostChanged: true });
    // An equivalent URL keeps the key: only a real move invalidates it.
    expect(config.updateProfile("a", { host: "https://other.example.com/" }))
      .toEqual({ hostChanged: false });
  });

  test("removing the current profile promotes another one", () => {
    const config = configWith(
      { a: { host: HOST, publicKey: "pk-a" }, b: { host: HOST, publicKey: "pk-b" } },
      "a",
    );
    config.removeProfile("a");
    expect(config.currentProfile).toBe("b");
  });

  test("round-trips through disk with 0600 permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "langfuse-config-"));
    try {
      const path = join(directory, "config.json");
      const config = Config.empty(path);
      config.addProfile("prod", HOST, "pk-prod");
      await config.save();

      const reloaded = await Config.load(path);
      expect(reloaded.profile("prod")).toEqual({ host: HOST, publicKey: "pk-prod" });

      const stats = await Bun.file(path).stat();
      expect(stats.mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("a missing file loads as an empty config", async () => {
    const config = await Config.load("/tmp/langfuse-cli-absent/config.json");
    expect(config.names()).toEqual([]);
  });

  test("a malformed file reports the path instead of throwing opaquely", async () => {
    const directory = await mkdtemp(join(tmpdir(), "langfuse-config-"));
    try {
      const path = join(directory, "config.json");
      await writeFile(path, "{ not json");
      await expect(Config.load(path)).rejects.toThrow("is not valid JSON");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("entries without a host are dropped rather than half-loaded", async () => {
    const directory = await mkdtemp(join(tmpdir(), "langfuse-config-"));
    try {
      const path = join(directory, "config.json");
      await writeFile(
        path,
        JSON.stringify({
          currentProfile: "broken",
          profiles: { broken: { publicKey: "pk" }, ok: { host: HOST, publicKey: "pk" } },
        }),
      );
      const config = await Config.load(path);
      expect(config.names()).toEqual(["ok"]);
      expect(config.currentProfile).toBe("ok");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("connection resolution", () => {
  test("order is --host, --profile, environment, then the default profile", () => {
    const config = configWith(
      { a: { host: "https://a.example.com", publicKey: "pk-a" }, b: { host: "https://b.example.com", publicKey: "pk-b" } },
      "a",
    );
    expect(config.resolveTarget({ explicitHost: "https://flag.example.com" }).host)
      .toBe("https://flag.example.com");
    expect(config.resolveTarget({ selectedProfile: "b" }).host)
      .toBe("https://b.example.com");
    expect(config.resolveTarget({ environmentHost: "https://env.example.com" }).host)
      .toBe("https://env.example.com");
    expect(config.resolveTarget({}).host).toBe("https://a.example.com");
  });

  test("an unconfigured CLI names the command that fixes it", () => {
    const config = Config.empty("/tmp/x.json");
    expect(() => config.resolveTarget({})).toThrow("langfuse-cli init");
  });

  test("a named profile that does not exist is an error, not a fallback", () => {
    const config = configWith({ a: { host: HOST, publicKey: "pk-a" } });
    expect(() => config.resolveTarget({ selectedProfile: "missing" })).toThrow(
      "does not exist",
    );
  });

  test("an explicit host never reads a stored secret", async () => {
    const config = configWith({ a: { host: HOST, publicKey: "pk-a" } }, "a");
    const store = trackingStore({ a: "sk-stored" });
    const target = config.resolveTarget({ explicitHost: "https://flag.example.com" });

    await expect(
      resolveCredentials(target, { publicKey: "pk-env" }, store),
    ).rejects.toThrow("LANGFUSE_SECRET_KEY is required with --host");
    expect(store.reads).toEqual([]);

    const resolved = await resolveCredentials(
      target,
      { publicKey: "pk-env", secretKey: "sk-env" },
      store,
    );
    expect(resolved.secretKey).toBe("sk-env");
    expect(resolved.credentialSource).toBe("environment");
    expect(store.reads).toEqual([]);
  });

  test("the environment secret overrides a profile's stored key", async () => {
    const config = configWith({ a: { host: HOST, publicKey: "pk-a" } }, "a");
    const store = trackingStore({ a: "sk-stored" });
    const resolved = await resolveCredentials(
      config.resolveTarget({}),
      { secretKey: "sk-env" },
      store,
    );
    expect(resolved.secretKey).toBe("sk-env");
    expect(resolved.credentialSource).toBe("environment");
    expect(store.reads).toEqual([]);
  });

  test("a profile without a stored key points at auth login", async () => {
    const config = configWith({ a: { host: HOST, publicKey: "pk-a" } }, "a");
    await expect(
      resolveCredentials(config.resolveTarget({}), {}, trackingStore()),
    ).rejects.toThrow("auth login");
  });

  test("a profile supplies host, public key and stored secret together", async () => {
    const config = configWith({ a: { host: HOST, publicKey: "pk-a" } }, "a");
    const resolved = await resolveCredentials(
      config.resolveTarget({}),
      {},
      trackingStore({ a: "sk-stored" }),
    );
    expect(resolved).toMatchObject({
      host: HOST,
      publicKey: "pk-a",
      secretKey: "sk-stored",
      profile: "a",
      credentialSource: "profile",
    });
  });
});

describe("credential file fallback", () => {
  test("lives beside the config file it belongs to", () => {
    expect(fallbackCredentialPath("/a/b/config.json")).toBe("/a/b/credentials.json");
  });

  test("stores secrets with 0600 permissions and deletes idempotently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "langfuse-creds-"));
    try {
      const path = join(directory, "credentials.json");
      const store = fileStore(path);
      expect(await store.get("a")).toBeNull();

      await store.set("a", "sk-secret");
      expect(await store.get("a")).toBe("sk-secret");

      const stats = await Bun.file(path).stat();
      expect(stats.mode & 0o777).toBe(0o600);

      await store.delete("a");
      await store.delete("a");
      expect(await store.get("a")).toBeNull();
      expect(await readFile(path, "utf8")).not.toContain("sk-secret");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("is reported as not system-backed so callers can warn", () => {
    expect(fileStore("/tmp/x.json").systemBacked).toBe(false);
  });
});

describe("error typing", () => {
  test("configuration failures carry the configuration exit code", () => {
    const config = Config.empty("/tmp/x.json");
    try {
      config.resolveTarget({});
      throw new Error("expected a CliError");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).exitCode).toBe(3);
    }
  });
});
