// Terminal prompts for the guided flows.
//
// Implemented directly on raw-mode stdin rather than through readline's
// private write hook, so masking does not depend on Node internals. Every
// prompt requires a real terminal: guided setup must never consume piped data
// that was meant for something else.
import { CliError, EXIT_USAGE } from "./errors";

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function assertInteractive(equivalent: string[]): void {
  if (isInteractive()) return;
  throw new CliError(
    `This command needs a terminal. Run it without redirecting input or output, or use the non-interactive equivalent:\n${equivalent
      .map((line) => `  ${line}`)
      .join("\n")}`,
    EXIT_USAGE,
  );
}

interface ReadOptions {
  mask?: boolean;
}

function readKeypresses(prompt: string, options: ReadOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stdout;
    let value = "";
    const wasRaw = input.isRaw ?? false;

    const cleanup = (): void => {
      input.setRawMode?.(wasRaw);
      input.pause();
      input.removeListener("data", onData);
    };

    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        // Enter (CR or LF) finishes the prompt.
        if (byte === 0x0d || byte === 0x0a) {
          output.write("\n");
          cleanup();
          resolve(value);
          return;
        }
        // Ctrl+C aborts without partially applying the flow.
        if (byte === 0x03) {
          output.write("\n");
          cleanup();
          reject(new CliError("Cancelled", EXIT_USAGE));
          return;
        }
        // Ctrl+D on an empty line behaves like an empty answer.
        if (byte === 0x04) {
          output.write("\n");
          cleanup();
          resolve(value);
          return;
        }
        // Backspace / delete.
        if (byte === 0x7f || byte === 0x08) {
          if (value.length > 0) {
            value = value.slice(0, -1);
            if (options.mask) output.write("\b \b");
            else output.write("\b \b");
          }
          continue;
        }
        // Ignore remaining control characters, including escape sequences.
        if (byte < 0x20) continue;
        const character = String.fromCharCode(byte);
        value += character;
        output.write(options.mask ? "*" : character);
      }
    };

    output.write(prompt);
    input.resume();
    input.setRawMode?.(true);
    input.on("data", onData);
  });
}

export async function promptLine(
  question: string,
  fallback?: string,
): Promise<string> {
  const suffix = fallback ? ` [${fallback}]` : "";
  const answer = (await readKeypresses(`${question}${suffix}: `, {})).trim();
  return answer || fallback || "";
}

export async function promptSecret(question: string): Promise<string> {
  return (await readKeypresses(`${question}: `, { mask: true })).trim();
}

export async function promptYesNo(
  question: string,
  fallback: boolean,
): Promise<boolean> {
  const hint = fallback ? "Y/n" : "y/N";
  const answer = (
    await readKeypresses(`${question} [${hint}]: `, {})
  )
    .trim()
    .toLowerCase();
  if (!answer) return fallback;
  return answer.startsWith("y");
}

/** Reads a secret from stdin for the non-interactive `--secret-key-stdin` path. */
export async function readSecretFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const secret = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  if (!secret) {
    throw new CliError("No secret key received on stdin", EXIT_USAGE);
  }
  return secret;
}
