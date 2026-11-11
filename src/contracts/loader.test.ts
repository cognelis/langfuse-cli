import { describe, expect, test } from "bun:test";

import { autoContractVersion, resolveContractVersion } from "./loader";
import { CliError, EXIT_NETWORK } from "../errors";
import type { ApiContractCatalog } from "./types";

const catalog: ApiContractCatalog = {
  schemaVersion: 1,
  latest: "4.10.0",
  versions: [
    { version: "3.216.0", sourceSha256: "3-latest" },
    { version: "4.10.0", sourceSha256: "4-latest" },
    { version: "3.0.0", sourceSha256: "3-oldest" },
    { version: "3.150.0", sourceSha256: "3-middle" },
  ],
};

function resolve(requested: string) {
  return resolveContractVersion({
    requested,
    host: "http://localhost:3000",
    timeoutMs: 1_000,
    catalog,
  });
}

describe("API contract version resolution", () => {
  test.each(["3", "v3", "3.x", "v3.x"])(
    "resolves major selector %s to the latest bundled v3 contract",
    async (requested) => {
      expect((await resolve(requested)).version).toBe("3.216.0");
    },
  );

  test("resolves another major independently", async () => {
    expect((await resolve("4")).version).toBe("4.10.0");
  });

  test("keeps exact selection exact", async () => {
    expect((await resolve("3.150.0")).version).toBe("3.150.0");
  });

  test("reports unavailable major selectors", async () => {
    await expect(resolve("5")).rejects.toThrow(
      "No bundled API contract for major version 5. Available majors: 3, 4",
    );
  });
});

describe("auto contract selection", () => {
  for (const [label, response] of [
    ["invalid JSON", () => new Response("not-json")],
    ["null JSON", () => new Response("null")],
    ["disconnected body", () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error("connection reset")); },
    }))],
    ["timed-out body", () => new Response(new ReadableStream({
      start(controller) { controller.error(new DOMException("timed out", "TimeoutError")); },
    }))],
  ] as const) {
    test(`reports ${label} as a version-detection failure`, async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => response()) as typeof fetch;
      try {
        const result = resolve("auto");
        await expect(result).rejects.toBeInstanceOf(CliError);
        await expect(result).rejects.toMatchObject({ exitCode: EXIT_NETWORK });
        await expect(result).rejects.toThrow("API version detection failed: GET http://localhost:3000/api/public/health");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }

  test("picks the exact snapshot, else the newest older one of the same major", () => {
    expect(autoContractVersion(catalog, "3.150.0")).toBe("3.150.0");
    expect(autoContractVersion(catalog, "3.162.0")).toBe("3.150.0");
    expect(autoContractVersion(catalog, "4.16.0")).toBe("4.10.0");
  });

  test("picks nothing for a server no bundled snapshot covers", () => {
    expect(autoContractVersion(catalog, "5.0.0")).toBeUndefined();
    expect(autoContractVersion(catalog, "2.9.0")).toBeUndefined();
  });
});
