import { describe, expect, test } from "bun:test";

import packageJson from "../package.json";
import { createApiClient, prepareRequest } from "./client";
import { CliError, EXIT_NETWORK } from "./errors";
import type { ApiOperation } from "./contracts/types";

const operation: ApiOperation = {
  key: "GET /api/public/health",
  operationId: "health_get",
  method: "GET",
  path: "/api/public/health",
  auth: { required: false, schemes: [] },
  command: {
    resource: "health",
    action: "get",
  },
  pathParameterOrder: [],
  parameters: [],
};

describe("API client", () => {
  for (const failure of [
    new Error("connection reset while reading body"),
    new DOMException("response body timed out", "TimeoutError"),
  ]) {
    test(`body failures use the network exit code: ${failure.name}`, async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => new Response(new ReadableStream({
        start(controller) {
          controller.error(failure);
        },
      }))) as typeof fetch;
      try {
        const request = createApiClient({ host: "https://example.com", timeoutMs: 1_000 })
          .call(operation, { path: {}, query: {}, headers: {}, cookies: {} });
        await expect(request).rejects.toBeInstanceOf(CliError);
        await expect(request).rejects.toMatchObject({
          exitCode: EXIT_NETWORK,
          message: `GET https://example.com/api/public/health failed: ${failure.message}`,
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }

  test("identifies requests with the CLI package version", () => {
    const request = prepareRequest(
      { host: "https://cloud.langfuse.com", timeoutMs: 1_000 },
      operation,
      { path: {}, query: {}, headers: {}, cookies: {} },
    );

    expect(request.headers.get("user-agent")).toBe(
      `langfuse-cli/${packageJson.version}`,
    );
  });
});
