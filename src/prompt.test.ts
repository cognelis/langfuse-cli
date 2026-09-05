import { describe, expect, test } from "bun:test";

import { CliError } from "./errors";
import { assertInteractive, isInteractive } from "./prompt";

describe("terminal detection", () => {
  test("requires both stdin and stdout to be a terminal", () => {
    // Under `bun test` output is captured, so this must not claim a terminal.
    expect(isInteractive()).toBe(Boolean(process.stdin.isTTY && process.stdout.isTTY));
  });
});

describe("assertInteractive", () => {
  test("refuses to run and prints the non-interactive equivalent", () => {
    if (isInteractive()) return;
    try {
      assertInteractive([
        "langfuse-cli profile add prod --host https://x --public-key pk",
        "printf '%s' \"$LANGFUSE_SECRET_KEY\" | langfuse-cli auth login --secret-key-stdin",
      ]);
      throw new Error("expected assertInteractive to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      const message = (error as CliError).message;
      // The point of failing here is that a piped stdin might be data meant for
      // something else; the user gets the scriptable commands instead.
      expect(message).toContain("needs a terminal");
      expect(message).toContain("langfuse-cli profile add prod");
      expect(message).toContain("--secret-key-stdin");
      expect((error as CliError).exitCode).toBe(2);
    }
  });
});
