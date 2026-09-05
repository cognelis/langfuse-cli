import { describe, expect, test } from "bun:test";

import { errorEnvelope, renderSuccess, successEnvelope } from "./output";

describe("success envelope", () => {
  test("carries the schema version, command and payload", () => {
    expect(successEnvelope("api.projects.list", { data: [] }, { status: 200 })).toEqual({
      schemaVersion: "1",
      command: "api.projects.list",
      data: { data: [] },
      meta: { status: 200 },
    });
  });

  test("drops absent and empty meta fields", () => {
    const envelope = successEnvelope("doctor", null, {
      status: undefined,
      profile: "prod",
      warnings: [],
    });
    expect(envelope.meta).toEqual({ profile: "prod" });
  });

  test("keeps warnings when there are any", () => {
    const envelope = successEnvelope("auth.login", null, { warnings: ["careful"] });
    expect(envelope.meta.warnings).toEqual(["careful"]);
  });
});

describe("error envelope", () => {
  test("reports the exit code alongside the message", () => {
    expect(errorEnvelope("api.projects.list", 3, "no credentials")).toEqual({
      schemaVersion: "1",
      command: "api.projects.list",
      error: { code: 3, message: "no credentials" },
    });
  });
});

describe("rendering", () => {
  const data = { id: 1 };

  test("json mode emits a single parseable line", () => {
    const rendered = renderSuccess("json", "api.things.list", data, { status: 200 });
    expect(rendered.endsWith("\n")).toBe(true);
    expect(rendered.trimEnd().includes("\n")).toBe(false);
    expect(JSON.parse(rendered)).toMatchObject({
      schemaVersion: "1",
      command: "api.things.list",
      data,
    });
  });

  test("raw mode emits the payload without the envelope", () => {
    const rendered = renderSuccess("raw", "api.things.list", data, { status: 200 });
    expect(JSON.parse(rendered)).toEqual(data);
    expect(rendered).not.toContain("schemaVersion");
  });

  test("default mode pretty-prints for humans", () => {
    expect(renderSuccess("default", "api.things.list", data)).toBe(
      '{\n  "id": 1\n}\n',
    );
  });

  test("a null body renders as nothing rather than the string null", () => {
    expect(renderSuccess("default", "api.things.delete", null)).toBe("");
    expect(renderSuccess("raw", "api.things.delete", null)).toBe("");
  });

  test("a string body is passed through with exactly one trailing newline", () => {
    expect(renderSuccess("default", "api.things.get", "plain")).toBe("plain\n");
    expect(renderSuccess("default", "api.things.get", "plain\n")).toBe("plain\n");
  });

  test("json mode still wraps a null body", () => {
    expect(JSON.parse(renderSuccess("json", "api.things.delete", null))).toEqual({
      schemaVersion: "1",
      command: "api.things.delete",
      data: null,
      meta: {},
    });
  });
});
