import { afterEach, describe, expect, test } from "bun:test";

import { checkAuth, checkHealth } from "./verify";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function respondWith(
  status: number,
  body: unknown,
  capture?: (url: string, init?: RequestInit) => void,
): void {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    capture?.(String(url), init);
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function failWith(error: Error): void {
  globalThis.fetch = (async () => {
    throw error;
  }) as unknown as typeof fetch;
}

describe("health probe", () => {
  test("reports the server version when the instance is reachable", async () => {
    respondWith(200, { status: "OK", version: "3.162.0" });
    const result = await checkHealth("https://lf.example.com", 1_000);
    expect(result).toMatchObject({ ok: true, status: 200, version: "3.162.0" });
    expect(result.message).toContain("3.162.0");
  });

  test("targets the public health route and tolerates a missing version", async () => {
    let seen = "";
    respondWith(200, {}, (url) => {
      seen = url;
    });
    const result = await checkHealth("https://lf.example.com/", 1_000);
    // The trailing slash must not produce a doubled path.
    expect(seen).toBe("https://lf.example.com/api/public/health");
    expect(result).toMatchObject({ ok: true });
    expect(result.version).toBeUndefined();
  });

  test("a non-2xx status is a failure that names the status", async () => {
    respondWith(502, {});
    const result = await checkHealth("https://lf.example.com", 1_000);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("502");
  });

  test("a timeout is described as one rather than leaking the abort error", async () => {
    failWith(new Error("The operation timed out"));
    const result = await checkHealth("https://lf.example.com", 1);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("request timed out");
  });
});

describe("auth probe", () => {
  test("sends basic auth and lists the reachable projects", async () => {
    let authorization: string | undefined;
    respondWith(
      200,
      { data: [{ name: "test" }, { name: "prod" }] },
      (_url, init) => {
        authorization = new Headers(init?.headers).get("authorization") ?? undefined;
      },
    );
    const result = await checkAuth("https://lf.example.com", "pk", "sk", 1_000);
    expect(result.ok).toBe(true);
    expect(result.projects).toEqual(["test", "prod"]);
    expect(authorization).toBe(`Basic ${Buffer.from("pk:sk").toString("base64")}`);
  });

  test("401 and 403 are reported as a rejected key pair, not a missing resource", async () => {
    for (const status of [401, 403]) {
      respondWith(status, {});
      const result = await checkAuth("https://lf.example.com", "pk", "sk", 1_000);
      expect(result.ok).toBe(false);
      expect(result.message).toContain("rejected");
      expect(result.status).toBe(status);
    }
  });

  test("never echoes the secret in its message", async () => {
    respondWith(401, {});
    const result = await checkAuth(
      "https://lf.example.com",
      "pk-lf-public",
      "sk-lf-super-secret",
      1_000,
    );
    expect(result.message).not.toContain("sk-lf-super-secret");
  });

  test("a malformed project list still counts as authenticated", async () => {
    respondWith(200, { data: "not-an-array" });
    const result = await checkAuth("https://lf.example.com", "pk", "sk", 1_000);
    expect(result.ok).toBe(true);
    expect(result.message).toBe("authenticated");
  });

  test("a transport failure is not mistaken for an auth failure", async () => {
    failWith(new Error("ECONNREFUSED"));
    const result = await checkAuth("https://lf.example.com", "pk", "sk", 1_000);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("cannot reach");
    expect(result.status).toBeUndefined();
  });
});
