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
  test("credential-free preparation keeps the execution URL and body serialization", () => {
    const authenticated: ApiOperation = {
      ...operation, method: "POST", path: "/api/public/widgets/{id}",
      auth: {required: true, schemes: ["BasicAuth"]},
      pathParameterOrder: ["id"],
      parameters: [{name: "id", cliName: "id", location: "path", required: true, style: "simple", explode: false, kind: "string"}],
      requestBody: {required: true, contentType: "application/json", fieldFlags: false, fields: []},
    };
    const config = {host: "https://example.com/proxy", timeoutMs: 1000, publicKey: "pk", secretKey: "secret"};
    const input = {path: {id: "a/b c"}, query: {}, headers: {}, cookies: {}, body: {values: [1, true]}};
    const planned = prepareRequest(config, authenticated, input, false);
    const executed = prepareRequest(config, authenticated, input);
    expect(planned.url.href).toBe(executed.url.href);
    expect(planned.body).toBe(executed.body);
    expect(JSON.parse(planned.body!)).toEqual({values: [1, true]});
    expect(planned.url.href).toBe("https://example.com/proxy/api/public/widgets/a%2Fb%20c");
    expect(planned.headers.has("authorization")).toBe(false);
    expect(executed.headers.has("authorization")).toBe(true);
  });
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
