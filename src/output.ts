// Stable machine-readable output envelope.
//
// Successful JSON output is versioned so a consumer can pin the shape it parses
// while the upstream payload keeps evolving. `--raw` opts out and emits only
// the payload for pipelines that already know the API shape.
//
// stdout carries results, stderr carries diagnostics. `doctor` is the single
// deliberate exception: it writes its report to stdout before exiting nonzero,
// because the report is the result.
export const SCHEMA_VERSION = "1";

export interface Meta {
  /** HTTP status for API commands; absent for local commands. */
  status?: number;
  elapsedMs?: number;
  /** Profile that supplied the connection, when one did. */
  profile?: string;
  host?: string;
  /** Pages fetched when --all walked a paginated list. */
  pages?: number;
  itemCount?: number;
  /** True when --max-items stopped pagination before the last page. */
  truncated?: boolean;
  warnings?: string[];
}

export interface SuccessEnvelope {
  schemaVersion: string;
  command: string;
  data: unknown;
  meta: Meta;
}

export interface ErrorEnvelope {
  schemaVersion: string;
  command: string;
  error: { code: number; message: string };
}

/**
 * "table" is the human-facing mode; a command renders its own layout for it.
 * renderSuccess falls back to pretty JSON for payloads with no table form,
 * such as an arbitrary API response.
 */
export type OutputMode = "table" | "json" | "raw";

export function successEnvelope(
  command: string,
  data: unknown,
  meta: Meta = {},
): SuccessEnvelope {
  return { schemaVersion: SCHEMA_VERSION, command, data, meta: compactMeta(meta) };
}

export function errorEnvelope(
  command: string,
  code: number,
  message: string,
): ErrorEnvelope {
  return {
    schemaVersion: SCHEMA_VERSION,
    command,
    error: { code, message },
  };
}

/** Drops absent fields so the envelope stays small and diffs stay readable. */
function compactMeta(meta: Meta): Meta {
  const compact: Meta = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    (compact as Record<string, unknown>)[key] = value;
  }
  return compact;
}

export function renderSuccess(
  mode: OutputMode,
  command: string,
  data: unknown,
  meta: Meta = {},
): string {
  if (mode === "raw") return renderPayload(data);
  if (mode === "json") {
    return `${JSON.stringify(successEnvelope(command, data, meta))}\n`;
  }
  return renderPayload(data);
}

function renderPayload(data: unknown): string {
  if (data === null || data === undefined) return "";
  if (typeof data === "string") {
    return data.endsWith("\n") ? data : `${data}\n`;
  }
  return `${JSON.stringify(data, null, 2)}\n`;
}

/** Writes warnings to stderr so stdout stays parseable. */
export function writeWarnings(warnings: string[]): void {
  for (const warning of warnings) {
    process.stderr.write(`warning: ${warning}\n`);
  }
}
