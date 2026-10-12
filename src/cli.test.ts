import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import {
  assertOperationCallable,
  assertPaginationUsage,
  callAllPages,
  extractPaginationFlags,
  operationByCommand,
  parseOperationInput,
  run,
  runApi,
  schemaOutput,
  writeResult,
} from "./cli";
import { createApiClient, prepareRequest } from "./client";
import { Config } from "./config";
import { fileStore } from "./credentials";
import { CliError } from "./errors";
import { compileApiContract } from "./contracts/compiler";
import {
  autoContractVersion,
  loadContractCatalog,
  setEmbeddedContracts,
} from "./contracts/loader";
import type { ApiOperation } from "./contracts/types";

async function captureOutput(
  fn: () => Promise<void>,
): Promise<{ stdout: string; stderr: string }> {
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  process.stdout.write = ((chunk: any) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: any) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    await fn();
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }

  return {
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
  };
}

/**
 * The built contracts, injected the way completion.test.ts does: they live in
 * dist/, so tests that need one are skipped until `bun run build` has run.
 */
const contractsLoaded = await (async () => {
  const directory = resolve(import.meta.dirname, "../dist/contracts");
  try {
    const embedded: Record<string, string> = {};
    for (const entry of await readdir(directory)) {
      if (!entry.endsWith(".json")) continue;
      embedded[basename(entry, ".json")] = await readFile(join(directory, entry), "utf8");
    }
    if (!embedded.catalog) return false;
    setEmbeddedContracts(embedded);
    return true;
  } catch {
    return false;
  }
})();

/**
 * Runs the CLI against a scratch config with the file credential store and no
 * LANGFUSE_API_VERSION, so the developer's own profiles and keyring stay out.
 */
async function scratchCli(
  fn: (cli: (...args: string[]) => Promise<{ stdout: string; stderr: string }>) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "langfuse-cli-scratch-"));
  const originalStore = process.env.LANGFUSE_CREDENTIAL_STORE;
  const originalVersion = process.env.LANGFUSE_API_VERSION;
  const originalExitCode = process.exitCode;
  process.env.LANGFUSE_CREDENTIAL_STORE = "file";
  delete process.env.LANGFUSE_API_VERSION;
  process.exitCode = undefined;
  try {
    await fn((...args) =>
      captureOutput(() =>
        run(["node", "langfuse-cli", "--config-file", join(directory, "config.json"), ...args]),
      ),
    );
  } finally {
    if (originalStore === undefined) delete process.env.LANGFUSE_CREDENTIAL_STORE;
    else process.env.LANGFUSE_CREDENTIAL_STORE = originalStore;
    if (originalVersion === undefined) delete process.env.LANGFUSE_API_VERSION;
    else process.env.LANGFUSE_API_VERSION = originalVersion;
    process.exitCode = originalExitCode ?? 0;
    await rm(directory, { recursive: true, force: true });
  }
}

/** Runs `fn` as if stdout were a terminal `columns` wide, or not a terminal. */
async function withTerminal<T>(
  columns: number | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const original = { isTTY: process.stdout.isTTY, columns: process.stdout.columns };
  Object.assign(process.stdout, { isTTY: columns !== undefined, columns });
  try {
    return await fn();
  } finally {
    Object.assign(process.stdout, original);
  }
}

describe("langfuse-cli get-skill", () => {
  test("reports that skills install replaced it", async () => {
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      const output = await captureOutput(() =>
        run(["node", "langfuse-cli", "get-skill"]),
      );

      expect(output.stdout).toBe("");
      expect(output.stderr).toContain("langfuse-cli skills install");
      expect(output.stderr).toContain("references/*.md");
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = originalExitCode ?? 0;
    }
  });
});

describe("removed flags", () => {
  test("--secret-key fails with the secure replacement", async () => {
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      const output = await captureOutput(() =>
        run(["node", "langfuse-cli", "--secret-key", "sk-lf-x", "api", "help"]),
      );

      expect(output.stderr).toContain("shell history");
      expect(output.stderr).toContain("auth login");
      expect(output.stderr).not.toContain("sk-lf-x");
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = originalExitCode ?? 0;
    }
  });

  test("--output selects a format and rejects anything else", async () => {
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      // It used to name a file; that role moved to --out-file, and --output now
      // chooses the format the way signoz-cli does.
      const output = await captureOutput(() =>
        run(["node", "langfuse-cli", "--output", "x.json", "api", "help"]),
      );

      expect(output.stderr).toContain("Unknown --output value");
      expect(output.stderr).toContain("auto, table, json or raw");
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = originalExitCode ?? 0;
    }
  });
});

describe("operation input parsing", () => {
  const promptGet: ApiOperation = {
    key: "GET /api/public/v2/prompts/{promptName}",
    operationId: "prompts_get",
    method: "GET",
    path: "/api/public/v2/prompts/{promptName}",
    auth: { required: false, schemes: [] },
    command: {
      resource: "prompts",
      action: "get",
    },
    pathParameterOrder: ["promptName"],
    parameters: [
      {
        location: "path",
        name: "promptName",
        cliName: "prompt-name",
        required: true,
        style: "simple",
        explode: false,
        kind: "string",
      },
      {
        location: "query",
        name: "resolve",
        cliName: "resolve",
        required: false,
        style: "form",
        explode: true,
        kind: "boolean",
      },
    ],
  };

  test("does not consume a positional after a bare boolean flag", async () => {
    const input = await parseOperationInput(promptGet, [
      "--resolve",
      "my-prompt-name",
    ]);

    expect(input.path.promptName).toBe("my-prompt-name");
    expect(input.query.resolve).toBe(true);
  });

  test("does not consume a positional after a negated boolean flag", async () => {
    const input = await parseOperationInput(promptGet, [
      "--no-resolve",
      "my-prompt-name",
    ]);

    expect(input.path.promptName).toBe("my-prompt-name");
    expect(input.query.resolve).toBe(false);
  });

  test("accepts an explicit inline boolean before a positional", async () => {
    const input = await parseOperationInput(promptGet, [
      "--resolve=false",
      "my-prompt-name",
    ]);

    expect(input.path.promptName).toBe("my-prompt-name");
    expect(input.query.resolve).toBe(false);
  });

  test("resolves contract-declared parameter flag aliases", async () => {
    const operation: ApiOperation = {
      ...promptGet,
      parameters: [
        ...promptGet.parameters,
        {
          location: "query",
          name: "version",
          cliName: "version",
          cliAliases: ["prompt-version"],
          required: false,
          style: "form",
          explode: true,
          kind: "number",
        },
      ],
    };
    const input = await parseOperationInput(operation, [
      "my-prompt-name",
      "--prompt-version",
      "2",
    ]);

    expect(input.query.version).toBe(2);

    // Missing-value errors must name the flag the user actually typed,
    // not the canonical cliName the alias resolves to.
    await expect(
      parseOperationInput(operation, ["my-prompt-name", "--prompt-version"]),
    ).rejects.toThrow("--prompt-version requires a value");
  });

  test("preserves the item type of array request-body flags", async () => {
    const contract = compileApiContract(
      { version: "test", ref: "test", sha256: "test" },
      `openapi: 3.0.3
info:
  title: Test
  version: test
paths:
  /models:
    put:
      operationId: models_put
      tags: [Models]
      deprecated: true
      security: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                customModels:
                  type: array
                  items:
                    type: string
      responses:
        "200":
          description: OK
`,
    );
    const operation = contract.operations[0];
    const field = operation.requestBody?.fields.find(
      (candidate) => candidate.name === "customModels",
    );

    expect(operation.deprecated).toBe(true);
    expect(field?.itemKind).toBe("string");
    expect(field?.cliName).toBe("custom-models");
    expect(
      await parseOperationInput(operation, ["--custom-models", "123"]),
    ).toMatchObject({ body: { customModels: ["123"] } });
  });

  test("rejects deprecated operations with replacement guidance", () => {
    const operation: ApiOperation = {
      ...promptGet,
      deprecated: true,
      description: "**Deprecated.** Use `GET /api/public/v3/prompts` instead.",
    };

    expect(() => assertOperationCallable(operation, "4.10.0")).toThrow(
      'Cannot call deprecated API operation "prompts get"',
    );
    expect(() => assertOperationCallable(operation, "4.10.0")).toThrow(
      "Use `GET /api/public/v3/prompts` instead.",
    );

    const schema = schemaOutput({
      schemaVersion: 1,
      apiVersion: "4.10.0",
      sourceSha256: "test",
      operations: [operation],
    });
    expect(schema.resources[0].actions[0].deprecated).toBe(true);
  });

  test("tells self-hosted v3 users how to reach a deprecated operation", () => {
    const operation: ApiOperation = { ...promptGet, deprecated: true };

    expect(() => assertOperationCallable(operation, "4.16.0", "selfhosted")).toThrow(
      'Self-hosted v3 servers still serve this endpoint: rerun with --api-version auto, or save it with "langfuse-cli profile update selfhosted --api-version auto"',
    );
    expect(() => assertOperationCallable(operation, "4.16.0")).toThrow(
      "langfuse-cli profile update <profile> --api-version auto",
    );
  });

  test("reports a separate value after a boolean flag as flag misuse", async () => {
    const observationsList: ApiOperation = {
      ...promptGet,
      operationId: "observations_getMany",
      path: "/api/public/v2/observations",
      command: { resource: "observations", action: "list" },
      pathParameterOrder: [],
      parameters: [
        {
          location: "query",
          name: "isRootObservation",
          cliName: "is-root-observation",
          required: false,
          style: "form",
          explode: true,
          kind: "boolean",
        },
      ],
    };

    await expect(
      parseOperationInput(observationsList, ["--is-root-observation", "true"]),
    ).rejects.toThrow(
      "--is-root-observation is a boolean flag: use --is-root-observation or --is-root-observation=true",
    );
    await expect(
      parseOperationInput(observationsList, ["--is-root-observation", "false"]),
    ).rejects.toThrow(
      "--is-root-observation is a boolean flag: use --no-is-root-observation or --is-root-observation=false",
    );
    // Any surplus word after the flag is its misplaced value, not a path argument.
    await expect(
      parseOperationInput(observationsList, ["--is-root-observation", "yes"]),
    ).rejects.toThrow("--is-root-observation is a boolean flag");
    await expect(
      parseOperationInput(promptGet, ["my-prompt", "--resolve", "extra"]),
    ).rejects.toThrow("--resolve is a boolean flag");
    // true/false is never read as a path argument, even where one is expected.
    await expect(parseOperationInput(promptGet, ["--resolve", "false"])).rejects.toThrow(
      "--resolve is a boolean flag",
    );
  });

  test("rejects nested body flags without consuming a positional", async () => {
    const operation: ApiOperation = {
      ...promptGet,
      key: "PATCH /api/public/widgets/{widgetId}",
      operationId: "widgets_update",
      method: "PATCH",
      path: "/api/public/widgets/{widgetId}",
      command: {
        resource: "widgets",
        action: "update",
      },
      pathParameterOrder: ["widgetId"],
      parameters: [
        {
          location: "path",
          name: "widgetId",
          cliName: "widget-id",
          required: true,
          style: "simple",
          explode: false,
          kind: "string",
        },
      ],
      requestBody: {
        required: true,
        contentType: "application/json",
        fieldFlags: true,
        fields: [
          {
            name: "chartConfig",
            cliName: "chart-config",
            required: false,
            kind: "object",
          },
        ],
      },
    };

    await expect(
      parseOperationInput(operation, [
        "--chart-config.show_value_labels",
        "widget-123",
      ]),
    ).rejects.toThrow(
      "Nested body option --chart-config.show_value_labels is unsupported; pass --chart-config with a JSON object or use --body-json",
    );

    expect(
      await parseOperationInput(operation, [
        "widget-123",
        "--chart-config",
        '{"show_value_labels":true}',
      ]),
    ).toMatchObject({
      path: { widgetId: "widget-123" },
      body: { chartConfig: { show_value_labels: true } },
    });
  });

  test("preserves an explicit null complete body", async () => {
    const operation: ApiOperation = {
      ...promptGet,
      key: "POST /api/public/widgets",
      operationId: "widgets_create",
      method: "POST",
      path: "/api/public/widgets",
      command: {
        resource: "widgets",
        action: "create",
      },
      pathParameterOrder: [],
      parameters: [],
      requestBody: {
        required: true,
        contentType: "application/json",
        fieldFlags: false,
        fields: [],
      },
    };

    expect(await parseOperationInput(operation, ["--body-json", "null"])).toEqual({
      path: {},
      query: {},
      headers: {},
      cookies: {},
      body: null,
    });
  });

  test("uses last-wins for repeated scalar body flags and appends arrays", async () => {
    const operation: ApiOperation = {
      ...promptGet,
      key: "POST /api/public/widgets",
      operationId: "widgets_create",
      method: "POST",
      path: "/api/public/widgets",
      command: { resource: "widgets", action: "create" },
      pathParameterOrder: [],
      parameters: [],
      requestBody: {
        required: true,
        contentType: "application/json",
        fieldFlags: true,
        fields: [
          { name: "content", cliName: "content", required: true, kind: "string" },
          {
            name: "tags",
            cliName: "tags",
            required: false,
            kind: "array",
            itemKind: "string",
          },
        ],
      },
    };

    expect(
      await parseOperationInput(operation, [
        "--content",
        "first",
        "--content",
        "second",
        "--tags",
        "one",
        "--tags",
        "two",
      ]),
    ).toMatchObject({
      body: { content: "second", tags: ["one", "two"] },
    });
  });

  test("body-channel usage errors include a shape hint", async () => {
    const operation: ApiOperation = {
      ...promptGet,
      key: "POST /api/public/v2/prompts",
      operationId: "prompts_create",
      method: "POST",
      path: "/api/public/v2/prompts",
      command: { resource: "prompts", action: "create" },
      pathParameterOrder: [],
      parameters: [],
      requestBody: {
        required: true,
        contentType: "application/json",
        fieldFlags: false,
        union: true,
        fields: [
          { name: "name", cliName: "name", required: true, kind: "string" },
          {
            name: "prompt",
            cliName: "prompt",
            required: true,
            kind: "array",
            itemKind: "object",
          },
          {
            name: "type",
            cliName: "type",
            required: true,
            kind: "string",
            enum: ["chat", "text"],
          },
          {
            name: "labels",
            cliName: "labels",
            required: false,
            kind: "array",
            itemKind: "string",
          },
        ],
      },
    };
    const hint = `--body-json '{"name":"…","prompt":[…],"type":"chat|text"}'`;
    try {
      await parseOperationInput(operation, ["--type", "text"]);
      throw new Error("expected a usage error");
    } catch (error) {
      expect((error as Error).message).toContain(
        "requires --body-json or --body-file",
      );
      expect((error as Error).message).toContain(hint);
      expect((error as Error).message).toContain("union body");
    }
    try {
      await parseOperationInput(operation, []);
      throw new Error("expected a usage error");
    } catch (error) {
      expect((error as Error).message).toContain("requires a request body");
      expect((error as Error).message).toContain(hint);
    }
  });

  test("discriminated unions parse field flags against the selected variant", async () => {
    const nameField = { name: "name", cliName: "name", required: true, kind: "string" as const };
    const typeField = (value: string) => ({
      name: "type",
      cliName: "type",
      required: true,
      kind: "string" as const,
      enum: [value],
    });
    const operation: ApiOperation = {
      ...promptGet,
      key: "POST /api/public/v2/prompts",
      operationId: "prompts_create",
      method: "POST",
      path: "/api/public/v2/prompts",
      command: { resource: "prompts", action: "create" },
      pathParameterOrder: [],
      parameters: [],
      requestBody: {
        required: true,
        contentType: "application/json",
        fieldFlags: false,
        union: true,
        discriminator: {
          field: "type",
          cliName: "type",
          variants: {
            text: [
              nameField,
              { name: "prompt", cliName: "prompt", required: true, kind: "string" },
              { name: "config", cliName: "config", required: false, kind: "any" },
              typeField("text"),
            ],
            chat: [
              nameField,
              {
                name: "prompt",
                cliName: "prompt",
                required: true,
                kind: "array",
                itemKind: "object",
              },
              typeField("chat"),
            ],
          },
        },
        fields: [nameField],
      },
    };

    // text variant: prompt stays a string
    expect(
      await parseOperationInput(operation, [
        "--type", "text", "--name", "hi", "--prompt", "lol",
      ]),
    ).toMatchObject({ body: { type: "text", name: "hi", prompt: "lol" } });

    // chat variant: whole JSON array sets the field
    expect(
      await parseOperationInput(operation, [
        "--type", "chat", "--name", "hi",
        "--prompt", '[{"role":"user","content":"hi"}]',
      ]),
    ).toMatchObject({
      body: { type: "chat", prompt: [{ role: "user", content: "hi" }] },
    });

    // chat variant: repeated flags append items
    expect(
      await parseOperationInput(operation, [
        "--type", "chat", "--name", "hi",
        "--prompt", '{"role":"system","content":"a"}',
        "--prompt", '{"role":"user","content":"b"}',
      ]),
    ).toMatchObject({
      body: {
        prompt: [
          { role: "system", content: "a" },
          { role: "user", content: "b" },
        ],
      },
    });

    // variant required fields are enforced
    await expect(
      parseOperationInput(operation, ["--type", "text", "--name", "hi"]),
    ).rejects.toThrow("Missing required body option(s): --prompt");

    // missing and invalid discriminators
    await expect(
      parseOperationInput(operation, ["--name", "hi"]),
    ).rejects.toThrow("field flags require --type (one of: text, chat)");
    await expect(
      parseOperationInput(operation, ["--type", "banana"]),
    ).rejects.toThrow('--type must be one of: text, chat (got "banana")');

    // the lossless channel bypasses variant parsing entirely
    expect(
      await parseOperationInput(operation, ["--body-json", '{"type":"text"}']),
    ).toMatchObject({ body: { type: "text" } });

    // "any" fields (unconstrained schemas like prompt config) keep
    // structured JSON values instead of stringifying them
    expect(
      await parseOperationInput(operation, [
        "--type", "text", "--name", "hi", "--prompt", "lol",
        "--config", '{"temperature":0}',
      ]),
    ).toMatchObject({ body: { config: { temperature: 0 } } });
    expect(
      await parseOperationInput(operation, [
        "--type", "text", "--name", "hi", "--prompt", "lol",
        "--config", "plain",
      ]),
    ).toMatchObject({ body: { config: "plain" } });

    // whole-array values are validated per item, like the repeated form
    await expect(
      parseOperationInput(operation, [
        "--type", "chat", "--name", "hi", "--prompt", "[1]",
      ]),
    ).rejects.toThrow("--prompt: array item 0 must be an object");

    // array values append to accumulated items in either order
    expect(
      await parseOperationInput(operation, [
        "--type", "chat", "--name", "hi",
        "--prompt", '{"role":"system","content":"a"}',
        "--prompt", '[{"role":"user","content":"b"}]',
      ]),
    ).toMatchObject({
      body: {
        prompt: [
          { role: "system", content: "a" },
          { role: "user", content: "b" },
        ],
      },
    });

    // discriminator flag plus the lossless channel is an explicit error,
    // not a contradictory fallthrough
    await expect(
      parseOperationInput(operation, ["--type", "text", "--body-json", '{"x":1}']),
    ).rejects.toThrow("Do not mix --body-json/--body-file with body field flags");
  });

  test("resolves tag and version command aliases", () => {
    const operation: ApiOperation = {
      ...promptGet,
      operationId: "scoresV3_getManyV3",
      path: "/api/public/v3/scores",
      command: {
        resource: "scores",
        action: "list",
        aliases: [
          { resource: "scores-v3", action: "list", source: "tag" },
        ],
      },
    };
    const contract = {
      schemaVersion: 1 as const,
      apiVersion: "4.10.0",
      sourceSha256: "test",
      operations: [operation],
    };

    expect(operationByCommand(contract, "scores-v3", "list")).toBe(operation);
  });
});

describe("API version reporting", () => {
  const catalog = {
    schemaVersion: 1 as const,
    latest: "4.10.0",
    versions: [
      { version: "3.150.0", sourceSha256: "old" },
      { version: "3.216.0", sourceSha256: "new" },
      { version: "4.10.0", sourceSha256: "latest" },
    ],
  };
  const config = {
    host: "http://localhost:3000",
    timeoutMs: 1_000,
    json: false,
    curl: false,
    showSecrets: false,
  };

  test("versions current prints the resolved major selection", async () => {
    const output = await captureOutput(() =>
      runApi({ ...config, apiVersion: "3" }, ["versions", "current"], catalog),
    );

    expect(output.stdout).toBe("3.216.0\n");
    expect(output.stderr).toBe("");
  });

  test("versions current resolves auto instead of echoing it", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> =>
      Response.json({ version: "3.216.1" })) as typeof fetch;
    try {
      const output = await captureOutput(() =>
        runApi(
          { ...config, apiVersion: "auto" },
          ["versions", "current"],
          catalog,
        ),
      );
      expect(output.stdout).toBe("3.216.0\n");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("versions current rejects invalid selectors", async () => {
    await expect(
      runApi(
        { ...config, apiVersion: "bogus" },
        ["versions", "current"],
        catalog,
      ),
    ).rejects.toThrow("Unknown API version bogus");
  });

  test("versions actions emit the envelope with --json and the payload with --raw", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> =>
      Response.json({ version: "3.216.1" })) as typeof fetch;
    const envelope = async (action: string, apiVersion?: string) =>
      JSON.parse(
        (
          await captureOutput(() =>
            runApi({ ...config, apiVersion, outputFlag: "json" }, ["versions", action], catalog),
          )
        ).stdout,
      );
    try {
      expect(await envelope("list")).toEqual({
        schemaVersion: "1",
        command: "api.versions.list",
        data: { versions: ["3.150.0", "3.216.0", "4.10.0"] },
        meta: { host: "http://localhost:3000" },
      });
      expect((await envelope("current")).data).toEqual({
        version: "4.10.0",
        requested: "latest",
      });
      expect((await envelope("current", "3")).data).toEqual({
        version: "3.216.0",
        requested: "3",
      });
      expect((await envelope("current", "auto")).data).toEqual({
        version: "3.216.0",
        requested: "auto",
        detected: "3.216.1",
      });
      const detected = await envelope("detect");
      expect(detected.command).toBe("api.versions.detect");
      expect(detected.data).toEqual({ detected: "3.216.1", version: "3.216.0" });

      const raw = await captureOutput(() =>
        runApi({ ...config, outputFlag: "raw" }, ["versions", "detect"], catalog),
      );
      expect(JSON.parse(raw.stdout)).toEqual({ detected: "3.216.1", version: "3.216.0" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("versions actions stay plain text when auto picks JSON for a pipe", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> =>
      Response.json({ version: "3.216.1" })) as typeof fetch;
    // A pipe without a format flag: outputMode is json, outputFlag is unset.
    const piped = { ...config, outputMode: "json" };
    try {
      const list = await captureOutput(() => runApi(piped, ["versions", "list"], catalog));
      expect(list.stdout).toBe("3.150.0\n3.216.0\n4.10.0\n");
      const detect = await captureOutput(() => runApi(piped, ["versions", "detect"], catalog));
      expect(detect.stdout).toBe("3.216.1 -> 3.216.0\n");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("pagination with --all", () => {
  const listOperation = (pagination: "page" | "cursor"): ApiOperation => ({
    key: "GET /api/public/widgets",
    operationId: "widgets_list",
    method: "GET",
    path: "/api/public/widgets",
    pagination,
    auth: { required: false, schemes: [] },
    command: { resource: "widgets", action: "list" },
    pathParameterOrder: [],
    parameters: [],
  });

  const stubClient = (responses: Array<Record<string, unknown>>) => {
    const calls: Record<string, unknown>[] = [];
    let index = 0;
    return {
      calls,
      call: async (_operation: ApiOperation, input: { query: Record<string, unknown> }) => {
        calls.push(structuredClone(input.query));
        const body = responses[Math.min(index++, responses.length - 1)];
        return { status: 200, headers: {}, body, ok: true } as const;
      },
    };
  };

  test("extracts --all and --max-items and validates usage", () => {
    const flags = extractPaginationFlags(["--limit", "5", "--all", "--max-items", "20"]);
    expect(flags).toEqual({ tokens: ["--limit", "5"], all: true, maxItems: 20 });
    expect(() =>
      assertPaginationUsage(listOperation("page"), { tokens: [], all: false, maxItems: 5 }, false),
    ).toThrow("--max-items requires --all");
    expect(() =>
      assertPaginationUsage(
        { ...listOperation("page"), pagination: undefined },
        { tokens: [], all: true },
        false,
      ),
    ).toThrow("not a paginated list operation");
    expect(() =>
      assertPaginationUsage(listOperation("page"), { tokens: [], all: true }, true),
    ).toThrow("--all cannot be combined with --curl");
  });

  test("follows page-based pagination to the last page", async () => {
    const client = stubClient([
      { data: [1, 2], meta: { page: 1, totalPages: 3, totalItems: 5 } },
      { data: [3, 4], meta: { page: 2, totalPages: 3, totalItems: 5 } },
      { data: [5], meta: { page: 3, totalPages: 3, totalItems: 5 } },
    ]);
    const input = { path: {}, query: {}, headers: {}, cookies: {} };
    const result = await callAllPages(client, listOperation("page"), input);
    expect(result.body).toEqual({
      data: [1, 2, 3, 4, 5],
      meta: { pages: 3, fetchedItems: 5, totalItems: 5, truncated: false },
    });
    expect(client.calls.map((query) => query.page)).toEqual([1, 2, 3]);
  });

  test("follows cursors until the server stops returning one", async () => {
    const client = stubClient([
      { data: ["a"], meta: { cursor: "next-1" } },
      { data: ["b"], meta: { cursor: "next-2" } },
      { data: ["c"], meta: {} },
    ]);
    const input = { path: {}, query: {}, headers: {}, cookies: {} };
    const result = await callAllPages(client, listOperation("cursor"), input);
    expect(result.body).toEqual({
      data: ["a", "b", "c"],
      meta: { pages: 3, fetchedItems: 3, truncated: false },
    });
    expect(client.calls.map((query) => query.cursor)).toEqual([
      undefined,
      "next-1",
      "next-2",
    ]);
  });

  test("caps items at --max-items and reports truncation", async () => {
    const client = stubClient([
      { data: [1, 2, 3], meta: { page: 1, totalPages: 9, totalItems: 27 } },
    ]);
    const input = { path: {}, query: {}, headers: {}, cookies: {} };
    const result = await callAllPages(client, listOperation("page"), input, 2);
    expect(result.body).toEqual({
      data: [1, 2],
      meta: { pages: 1, fetchedItems: 2, totalItems: 27, truncated: true },
    });
  });

  test("caps requests at 100 pages regardless of --max-items", async () => {
    let calls = 0;
    const endless = {
      call: async () => {
        calls++;
        return {
          status: 200,
          headers: {},
          body: { data: [calls], meta: { cursor: `next-${calls}` } },
          ok: true,
        } as const;
      },
    };
    const result = await callAllPages(
      endless,
      listOperation("cursor"),
      { path: {}, query: {}, headers: {}, cookies: {} },
      100_000,
    );
    expect(calls).toBe(100);
    expect((result.body as any).meta).toMatchObject({
      pages: 100,
      fetchedItems: 100,
      truncated: true,
    });
  });

  test("returns a failing page unchanged", async () => {
    const failing = {
      call: async () =>
        ({ status: 500, headers: {}, body: { message: "boom" }, ok: false }) as const,
    };
    const result = await callAllPages(
      failing,
      listOperation("page"),
      { path: {}, query: {}, headers: {}, cookies: {} },
    );
    expect(result.status).toBe(500);
    expect(result.ok).toBe(false);
  });
});

describe("exit code taxonomy", () => {
  const getOperation: ApiOperation = {
    key: "GET /api/public/v2/prompts/{promptName}",
    operationId: "prompts_get",
    method: "GET",
    path: "/api/public/v2/prompts/{promptName}",
    auth: { required: false, schemes: [] },
    command: { resource: "prompts", action: "get" },
    pathParameterOrder: ["promptName"],
    parameters: [
      {
        location: "path",
        name: "promptName",
        cliName: "prompt-name",
        required: true,
        style: "simple",
        explode: false,
        kind: "string",
      },
    ],
  };

  test("missing credentials fail with the configuration exit code", () => {
    const operation: ApiOperation = {
      ...getOperation,
      auth: { required: true, schemes: ["BasicAuth"] },
    };
    try {
      prepareRequest(
        { host: "https://example.com", timeoutMs: 1000 },
        operation,
        { path: { promptName: "x" }, query: {}, headers: {}, cookies: {} },
      );
      throw new Error("expected a configuration error");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).exitCode).toBe(3);
    }
  });

  test("network failures carry exit code 4 and name the request", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as typeof fetch;
    try {
      await createApiClient({ host: "https://example.com", timeoutMs: 50 }).call(
        getOperation,
        { path: { promptName: "x" }, query: {}, headers: {}, cookies: {} },
      );
      throw new Error("expected a network error");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).exitCode).toBe(4);
      expect((error as CliError).message).toContain(
        "GET https://example.com/api/public/v2/prompts/x",
      );
      expect((error as CliError).message).toContain("connection refused");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("unreadable body files carry the local-failure exit code", async () => {
    const operation: ApiOperation = {
      ...getOperation,
      pathParameterOrder: [],
      parameters: [],
      requestBody: {
        required: true,
        contentType: "application/json",
        fieldFlags: false,
        fields: [],
      },
    };
    try {
      await parseOperationInput(operation, [
        "--body-file",
        "/nonexistent/cli-test-body.json",
      ]);
      throw new Error("expected a local file error");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).exitCode).toBe(6);
    }
  });

  test("HTTP failures set exit code 5", async () => {
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await captureOutput(() =>
        writeResult(
          { status: 404, headers: {}, body: { message: "nope" }, ok: false },
          {
            host: "https://example.com",
            timeoutMs: 1000,
            json: true,
            curl: false,
            showSecrets: false,
          },
        ),
      );
      expect(process.exitCode).toBe(5);
    } finally {
      process.exitCode = originalExitCode ?? 0;
    }
  });
});

describe("result output", () => {
  test("writes an empty file for an empty response body", async () => {
    const directory = await mkdtemp(join(tmpdir(), "langfuse-cli-test-"));
    const output = join(directory, "response.json");
    try {
      await writeResult(
        { status: 204, headers: {}, body: null, ok: true },
        {
          host: "http://localhost",
          timeoutMs: 1_000,
          outputMode: "default",
          curl: false,
          showSecrets: false,
          outFile: output,
          configFile: Config.empty("/dev/null"),
          store: fileStore(join(directory, "credentials.json")),
          environment: {},
        },
      );

      expect(await Bun.file(output).text()).toBe("");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("profile descriptions", () => {
  test("are stored, listed, shown and cleared", async () => {
    const directory = await mkdtemp(join(tmpdir(), "langfuse-cli-profile-"));
    const originalStore = process.env.LANGFUSE_CREDENTIAL_STORE;
    const originalExitCode = process.exitCode;
    process.env.LANGFUSE_CREDENTIAL_STORE = "file";
    process.exitCode = undefined;
    const argv = (...args: string[]) => [
      "node",
      "langfuse-cli",
      "--json",
      "--config-file",
      join(directory, "config.json"),
      ...args,
    ];
    // Every call made through this helper succeeds and prints one JSON envelope.
    const cli = async (...args: string[]): Promise<any> =>
      JSON.parse((await captureOutput(() => run(argv(...args)))).stdout);

    try {
      const added = await cli(
        "profile", "add", "prod",
        "--host", "https://langfuse.example.com",
        "--public-key", "pk-lf-prod",
        "--description", "Production traces",
      );
      expect(added.data.description).toBe("Production traces");
      await cli(
        "profile", "add", "test",
        "--host", "https://test.langfuse.example.com",
        "--public-key", "pk-lf-test",
      );
      const listed = (await cli("profile", "list")).data as Array<Record<string, unknown>>;
      expect(listed.find((profile) => profile.name === "prod")?.description).toBe(
        "Production traces",
      );
      expect(listed.find((profile) => profile.name === "test")).not.toHaveProperty(
        "description",
      );

      // A description alone keeps the host, so the stored secret is not cleared.
      const updated = await cli("profile", "update", "test", "--description", "Shared test project");
      expect(updated.data.description).toBe("Shared test project");
      expect(updated.data.secretCleared).toBe(false);
      expect((await cli("profile", "show", "test")).data.description).toBe(
        "Shared test project",
      );
      const cleared = await cli("profile", "update", "test", "--description", "");
      expect(cleared.data).not.toHaveProperty("description");

      const invalid = await captureOutput(() =>
        run(argv("profile", "update", "test", "--description", "two\nlines")),
      );
      expect(invalid.stderr).toContain("one line");
      expect(process.exitCode).toBe(2);
    } finally {
      if (originalStore === undefined) delete process.env.LANGFUSE_CREDENTIAL_STORE;
      else process.env.LANGFUSE_CREDENTIAL_STORE = originalStore;
      process.exitCode = originalExitCode ?? 0;
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("profile --help prints usage instead of failing", async () => {
    const output = await captureOutput(() =>
      run(["node", "langfuse-cli", "profile", "add", "--help"]),
    );
    expect(output.stdout).toContain("langfuse-cli profile add <name>");
    expect(output.stdout).toContain("--description");
    expect(output.stderr).toBe("");
  });
});

describe.skipIf(!contractsLoaded)("api help", () => {
  test("--help after a resource or an action prints that help", () =>
    scratchCli(async (cli) => {
      const resource = await cli("api", "projects", "--help");
      expect(resource.stderr).toBe("");
      expect(resource.stdout).toContain("Usage: langfuse-cli api projects <action>");

      const action = await cli("api", "projects", "list", "--help");
      expect(action.stderr).toBe("");
      expect(action.stdout).toContain("Usage: langfuse-cli api projects list");

      const versions = await cli("api", "versions", "--help");
      expect(versions.stderr).toBe("");
      expect(versions.stdout).toContain("Usage: langfuse-cli api versions <action>");
    }));

  test("prints option descriptions whole, wrapped under the description column", () =>
    scratchCli(async (cli) => {
      const help = (columns?: number) =>
        withTerminal(columns, async () =>
          (await cli("--api-version", "3.150.0", "api", "traces", "list", "--help")).stdout,
        );
      const widest = (text: string) =>
        Math.max(...text.split("\n").map((line) => line.length));

      const piped = await help();
      expect(piped).not.toContain("…");
      // Past both the old 100-character help cut and the old 200-character contract cut.
      expect(piped.replace(/\s+/g, " ")).toContain(
        "excluded 'metrics' returns -1 for 'totalCost' and 'latency'.",
      );
      const lines = piped.split("\n");
      const fields = lines.findIndex((line) => line.startsWith("  --fields "));
      expect(lines[fields + 1]).toMatch(/^ {41}\S/);
      // Not a terminal: 100 columns, used to the full.
      expect(widest(piped)).toBeLessThanOrEqual(100);
      expect(widest(piped)).toBeGreaterThan(90);

      expect(widest(await help(90))).toBeLessThanOrEqual(90);
    }));

  test("api versions honors --json and --raw and stays plain text without them", () =>
    scratchCli(async (cli) => {
      const { versions } = await loadContractCatalog();
      const all = versions.map((entry) => entry.version);

      const json = JSON.parse((await cli("--json", "api", "versions", "list")).stdout);
      expect(json.command).toBe("api.versions.list");
      expect(json.data).toEqual({ versions: all });
      expect(JSON.parse((await cli("--raw", "api", "versions", "list")).stdout)).toEqual({
        versions: all,
      });
      expect((await cli("api", "versions", "list")).stdout).toBe(`${all.join("\n")}\n`);
    }));
});

describe("profile API versions", () => {
  test("are stored, listed, shown, updated alone and cleared", () =>
    scratchCli(async (cli) => {
      const json = async (...args: string[]): Promise<any> =>
        JSON.parse((await cli("--json", ...args)).stdout);

      // auto is detected on each call, so saving it needs no contract or network.
      const added = await json(
        "profile", "add", "selfhosted",
        "--host", "https://langfuse.internal.example.com",
        "--public-key", "pk-lf-self",
        "--api-version", "auto",
      );
      expect(added.data.apiVersion).toBe("auto");
      await json(
        "profile", "add", "cloud",
        "--host", "https://cloud.langfuse.com",
        "--public-key", "pk-lf-cloud",
      );
      const listed = (await json("profile", "list")).data as Array<Record<string, unknown>>;
      expect(listed.find((profile) => profile.name === "selfhosted")?.apiVersion).toBe("auto");
      expect(listed.find((profile) => profile.name === "cloud")).not.toHaveProperty("apiVersion");

      const updated = await json("profile", "update", "cloud", "--api-version", "auto");
      expect(updated.data.apiVersion).toBe("auto");
      expect(updated.data.secretCleared).toBe(false);
      expect((await json("profile", "show", "cloud")).data.apiVersion).toBe("auto");
      const cleared = await json("profile", "update", "cloud", "--api-version", "");
      expect(cleared.data).not.toHaveProperty("apiVersion");
    }));

  test.skipIf(!contractsLoaded)(
    "apply after --api-version and LANGFUSE_API_VERSION, and only to their profile",
    () =>
      scratchCli(async (cli) => {
        const { latest, versions } = await loadContractCatalog();
        const [saved, fromEnvironment, fromFlag] = versions.map((entry) => entry.version);
        const current = async (...args: string[]) =>
          (await cli(...args, "api", "versions", "current")).stdout.trim();

        await cli(
          "profile", "add", "selfhosted",
          "--host", "https://langfuse.internal.example.com",
          "--public-key", "pk-lf-self",
          "--api-version", saved,
        );
        expect(await current()).toBe(saved);
        process.env.LANGFUSE_API_VERSION = fromEnvironment;
        expect(await current()).toBe(fromEnvironment);
        expect(await current("--api-version", fromFlag)).toBe(fromFlag);
        delete process.env.LANGFUSE_API_VERSION;
        // An explicit host is not the profile's instance.
        expect(await current("--host", "https://other.example.com")).toBe(latest);
      }),
  );

  test.skipIf(!contractsLoaded)("must name a bundled contract unless auto", () =>
    scratchCli(async (cli) => {
      await cli(
        "profile", "add", "selfhosted",
        "--host", "https://langfuse.internal.example.com",
        "--public-key", "pk-lf-self",
        "--api-version", "3",
      );
      // A server version is not a bundled snapshot; auto or a major selects one.
      const rejected = await cli("profile", "update", "selfhosted", "--api-version", "3.162.0");
      expect(rejected.stderr).toContain("Unknown API version 3.162.0");
      expect(process.exitCode).toBe(3);
      const shown = JSON.parse((await cli("--json", "profile", "show", "selfhosted")).stdout);
      expect(shown.data.apiVersion).toBe("3");
    }));
});

describe.skipIf(!contractsLoaded)("doctor contract check", () => {
  /**
   * Answers the two requests doctor makes — the health probe, reporting
   * `version`, and the project list — recording each one, with a secret key in
   * the environment so no keyring is involved.
   */
  async function againstServer(
    version: string,
    fn: (requests: string[]) => Promise<void>,
  ): Promise<void> {
    const originalFetch = globalThis.fetch;
    const originalSecret = process.env.LANGFUSE_SECRET_KEY;
    const requests: string[] = [];
    globalThis.fetch = (async (url: string | URL): Promise<Response> => {
      requests.push(String(url));
      return String(url).endsWith("/api/public/health")
        ? Response.json({ status: "OK", version })
        : Response.json({ data: [{ name: "test" }] });
    }) as typeof fetch;
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
    try {
      await fn(requests);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalSecret === undefined) delete process.env.LANGFUSE_SECRET_KEY;
      else process.env.LANGFUSE_SECRET_KEY = originalSecret;
    }
  }

  const selfhosted = [
    "profile", "add", "selfhosted",
    "--host", "https://langfuse.internal.example.com",
    "--public-key", "pk-lf-self",
  ];

  test("names the profile in the fix when the contract in use does not fit the server", () =>
    scratchCli((cli) =>
      againstServer("3.162.0", async (requests) => {
        const catalog = await loadContractCatalog();
        const fit = autoContractVersion(catalog, "3.162.0");
        await cli(...selfhosted);

        const report = JSON.parse((await cli("--json", "--profile", "selfhosted", "doctor")).stdout);
        expect(report.data.checks[5]).toEqual({
          name: "contract",
          status: "pass",
          message: `API contract ${catalog.latest} does not fit Langfuse 3.162.0 (auto picks ${fit}): run \`langfuse-cli profile update selfhosted --api-version auto\``,
        });
        // Advice only: still healthy, still exit 0, and no request beyond the usual two.
        expect(report.data.healthy).toBe(true);
        expect(process.exitCode ?? 0).toBe(0);
        expect(requests).toHaveLength(2);

        const table = await cli("--output", "table", "--profile", "selfhosted", "doctor");
        expect(table.stdout).toMatch(
          /^contract +pass +API contract \S+ does not fit Langfuse 3\.162\.0 /m,
        );
      }),
    ));

  test("gives the flag or variable as the fix without a profile, or when one of them chose the contract", () =>
    scratchCli((cli) =>
      againstServer("3.162.0", async () => {
        const fix = "pass --api-version auto or set LANGFUSE_API_VERSION=auto";
        const contract = async (...args: string[]): Promise<string> =>
          JSON.parse((await cli("--json", ...args, "doctor")).stdout).data.checks[5].message;

        expect(
          await contract("--host", "https://langfuse.internal.example.com", "--public-key", "pk-lf-self"),
        ).toEndWith(fix);

        // Saving auto with the profile would not beat LANGFUSE_API_VERSION.
        await cli(...selfhosted);
        process.env.LANGFUSE_API_VERSION = "4";
        expect(await contract("--profile", "selfhosted")).toEndWith(fix);
      }),
    ));

  test("reports a fit under auto without probing the server again", () =>
    scratchCli((cli) =>
      againstServer("3.162.0", async (requests) => {
        const fit = autoContractVersion(await loadContractCatalog(), "3.162.0");
        await cli(...selfhosted, "--api-version", "auto");

        const report = JSON.parse((await cli("--json", "--profile", "selfhosted", "doctor")).stdout);
        expect(report.data.checks[5]).toEqual({
          name: "contract",
          status: "pass",
          message: `API contract ${fit} fits Langfuse 3.162.0`,
        });
        expect(requests).toHaveLength(2);
      }),
    ));
});
