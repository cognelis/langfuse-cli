import { readFile, writeFile } from "node:fs/promises";
import { text as streamText } from "node:stream/consumers";

import packageJson from "../package.json";

import { createApiClient, renderCurl } from "./client";
import {
  Config,
  DEFAULT_HOST,
  defaultConfigPath,
  fallbackCredentialPath,
  resolveCredentials,
} from "./config";
import { resolveCredentialStore, type CredentialStore } from "./credentials";
import {
  CliError,
  EXIT_CONFIG,
  EXIT_HTTP,
  EXIT_LOCAL,
  EXIT_NETWORK,
  EXIT_USAGE,
} from "./errors";
import {
  GLOBAL_BOOLEAN_FLAG_NAMES,
  GLOBAL_VALUE_FLAG_NAMES,
  REMOVED_FLAGS,
} from "./flags";
import { renderSuccess, type Meta, type OutputMode } from "./output";
import { renderTable } from "./table";
import {
  loadApiContract,
  loadContractCatalog,
  resolveContractVersion,
} from "./contracts/loader";
import type {
  ApiBodyField,
  ApiCallInput,
  ApiContract,
  ApiContractCatalog,
  ApiOperation,
  ApiParameter,
  ApiResult,
  JsonValue,
  ValueKind,
} from "./contracts/types";
import type { CommandContext } from "./commands/connection";
import {
  authCheck,
  authLogin,
  authLogout,
  configPath,
  configShow,
  doctor,
  profileAdd,
  profileList,
  profileRemove,
  profileShow,
  profileUpdate,
  profileUse,
} from "./commands/connection";
import { init } from "./commands/init";
import { installSkills, parseSkillTarget } from "./commands/skills";
import {
  complete,
  parseCompletionShell,
  renderCompletionScript,
  renderCompletions,
} from "./commands/completion";

const DEFAULT_TIMEOUT_MS = 30_000;
const VALUE_FLAGS = new Set(GLOBAL_VALUE_FLAG_NAMES.map((name) => `--${name}`));
const BOOLEAN_FLAGS = new Set(
  GLOBAL_BOOLEAN_FLAG_NAMES.map((name) => `--${name}`),
);

interface ParsedGlobals {
  values: Record<string, string>;
  booleans: Set<string>;
  args: string[];
}

interface RuntimeConfig {
  host: string;
  profile?: string;
  publicKey?: string;
  apiVersion?: string;
  timeoutMs: number;
  outputMode: OutputMode;
  curl: boolean;
  showSecrets: boolean;
  outFile?: string;
  configFile: Config;
  store: CredentialStore;
  environment: { host?: string; publicKey?: string; secretKey?: string };
  hostFlag?: string;
  publicKeyFlag?: string;
  profileFlag?: string;
}

function flagKey(flag: string): string {
  return flag.replace(/^--/, "");
}

function extractGlobals(args: string[]): ParsedGlobals {
  const values: Record<string, string> = {};
  const booleans = new Set<string>();
  const remaining: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    const equals = token.indexOf("=");
    const name = equals === -1 ? token : token.slice(0, equals);
    // A removed option must not fall through and be reinterpreted as an
    // operation argument; say what replaced it instead.
    const removed = REMOVED_FLAGS.get(flagKey(name));
    if (removed && name.startsWith("--")) {
      throw new CliError(removed, EXIT_USAGE);
    }
    if (VALUE_FLAGS.has(name)) {
      const value = equals === -1 ? args[index + 1] : token.slice(equals + 1);
      if (value === undefined || (equals === -1 && value.startsWith("--"))) {
        throw new CliError(`${name} requires a value`);
      }
      values[flagKey(name)] = value;
      if (equals === -1) index++;
      continue;
    }
    if (BOOLEAN_FLAGS.has(name)) {
      booleans.add(flagKey(name));
      continue;
    }
    remaining.push(token);
  }
  return { values, booleans, args: remaining };
}

function parseEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/**
 * Chooses the output format.
 *
 * `auto` — the default — prints a table on a terminal and the JSON envelope
 * everywhere else, so a human reads columns while a pipeline receives parseable
 * output without having to pass a flag.
 */
function resolveOutputMode(globals: ParsedGlobals): OutputMode {
  const requested = globals.values.output;
  if (requested !== undefined) {
    if (requested === "json") return "json";
    if (requested === "raw") return "raw";
    if (requested === "table") return "table";
    if (requested !== "auto") {
      throw new CliError(
        `Unknown --output value: ${requested} (expected auto, table, json or raw)`,
      );
    }
  }
  if (globals.booleans.has("raw")) return "raw";
  if (globals.booleans.has("json")) return "json";
  return process.stdout.isTTY ? "table" : "json";
}

async function runtimeConfig(globals: ParsedGlobals): Promise<RuntimeConfig> {
  let fileEnv: Record<string, string> = {};
  if (globals.values.env) {
    try {
      fileEnv = parseEnv(await readFile(globals.values.env, "utf8"));
    } catch (error) {
      throw new CliError(
        `Cannot read --env file ${globals.values.env}: ${error instanceof Error ? error.message : String(error)}`,
        EXIT_CONFIG,
      );
    }
  }
  const env = { ...process.env, ...fileEnv };
  const timeoutMs = Number(globals.values.timeout ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new CliError("--timeout must be a positive number of milliseconds");
  }
  if (globals.booleans.has("json") && globals.booleans.has("raw")) {
    throw new CliError("--json and --raw are mutually exclusive");
  }
  const outputMode = resolveOutputMode(globals);
  const configFilePath = globals.values["config-file"] ?? defaultConfigPath();
  const configFile = await Config.load(configFilePath);
  // The file fallback lives beside the config it belongs to, so pointing
  // --config-file at a scratch directory isolates credentials as well.
  // LANGFUSE_CREDENTIAL_STORE=file forces that backend, for tests and for hosts
  // with no reachable keyring.
  const store = await resolveCredentialStore({
    fallbackPath: fallbackCredentialPath(configFilePath),
    forceFile: env.LANGFUSE_CREDENTIAL_STORE === "file",
  });
  const environment = {
    host: env.LANGFUSE_BASE_URL ?? env.LANGFUSE_HOST,
    publicKey: env.LANGFUSE_PUBLIC_KEY,
    secretKey: env.LANGFUSE_SECRET_KEY,
  };

  // The host is resolved eagerly because contract selection needs it, but
  // credentials are not: `api help` and `api schema` must keep working on a
  // machine that has never been configured.
  let host = DEFAULT_HOST;
  let profile: string | undefined;
  try {
    const target = configFile.resolveTarget({
      explicitHost: globals.values.host,
      explicitPublicKey: globals.values["public-key"],
      selectedProfile: globals.values.profile,
      environmentHost: environment.host,
    });
    host = target.host;
    profile = target.profile;
  } catch (error) {
    // An explicitly named profile that does not exist is a real error; an
    // absent configuration simply falls back to the public cloud host.
    if (globals.values.profile || globals.values.host) throw error;
  }

  return {
    host,
    profile,
    publicKey: globals.values["public-key"] ?? environment.publicKey,
    apiVersion: globals.values["api-version"] ?? env.LANGFUSE_API_VERSION,
    timeoutMs,
    outputMode,
    curl: globals.booleans.has("curl"),
    showSecrets: globals.booleans.has("show-secrets"),
    outFile: globals.values["out-file"],
    configFile,
    store,
    environment,
    hostFlag: globals.values.host,
    publicKeyFlag: globals.values["public-key"],
    profileFlag: globals.values.profile,
  };
}

/**
 * Resolves the credentials for an actual API call. Kept separate from
 * `runtimeConfig` so discovery commands never require a configured connection.
 */
async function connect(config: RuntimeConfig) {
  const target = config.configFile.resolveTarget({
    explicitHost: config.hostFlag,
    explicitPublicKey: config.publicKeyFlag,
    selectedProfile: config.profileFlag,
    environmentHost: config.environment.host,
  });
  return resolveCredentials(target, config.environment, config.store);
}

function printHelp(): void {
  process.stdout.write(`langfuse-cli — Interact with Langfuse from the command line

Usage: langfuse [options] <command>

Commands:
  init                    Guided setup: create or repair a profile
  doctor                  Diagnose the active connection (read-only)
  api                     Interact with the Langfuse REST API
  auth                    login | check | logout
  profile                 add | update | list | show | use | remove
  config                  path | show
  skills                  install [--target all|codex|claude]
  completion              Emit a zsh, bash or fish completion script

Options:
  --profile <name>        Use a named profile for this command
  --host <url>            Langfuse host (default: ${DEFAULT_HOST})
  --public-key <key>      Langfuse public key (or LANGFUSE_PUBLIC_KEY)
  --config-file <path>    Config file (default: ${defaultConfigPath()})
  --env <path>            Load env vars from a file
  --api-version <version> Exact/major version, latest, or auto
  --timeout <ms>          Request timeout (default: ${DEFAULT_TIMEOUT_MS})
  --output <format>       auto | table | json | raw (default: auto)
  --json                  Versioned JSON envelope (same as --output json)
  --raw                   Payload only, no envelope
  --out-file <path>       Write the response body to a file
  -h, --help              Show help
  --version               Show CLI version

There is no --secret-key flag: an argument-borne secret leaks into shell
history and the process list. Use \`langfuse-cli auth login\` or LANGFUSE_SECRET_KEY.

Connection order:
  --host, then --profile, then LANGFUSE_HOST, then the default profile.
  LANGFUSE_SECRET_KEY overrides a profile's stored key.

Exit codes:
  0 success · 2 usage · 3 configuration · 4 network · 5 HTTP error · 6 local file

Examples:
  langfuse-cli init
  langfuse-cli doctor --json
  langfuse-cli api prompts list
  langfuse-cli --profile prod api observations list --limit 20
  langfuse-cli api prompts create --body-json '{"name":"my-prompt","type":"text","prompt":"Hello"}'
`);
}

interface CommandBinding {
  operation: ApiOperation;
  action: string;
  alias: boolean;
}

function canonicalResourceMap(contract: ApiContract): Map<string, ApiOperation[]> {
  const resources = new Map<string, ApiOperation[]>();
  for (const operation of contract.operations) {
    const existing = resources.get(operation.command.resource) ?? [];
    existing.push(operation);
    resources.set(operation.command.resource, existing);
  }
  for (const operations of resources.values()) {
    operations.sort((left, right) =>
      left.command.action.localeCompare(right.command.action),
    );
  }
  return resources;
}

function resourceMap(contract: ApiContract): Map<string, CommandBinding[]> {
  const resources = new Map<string, CommandBinding[]>();
  const add = (resource: string, binding: CommandBinding) => {
    const existing = resources.get(resource) ?? [];
    existing.push(binding);
    resources.set(resource, existing);
  };
  for (const operation of contract.operations) {
    add(operation.command.resource, {
      operation,
      action: operation.command.action,
      alias: false,
    });
    for (const alias of operation.command.aliases ?? []) {
      add(alias.resource, { operation, action: alias.action, alias: true });
    }
  }
  for (const bindings of resources.values()) {
    bindings.sort((left, right) => left.action.localeCompare(right.action));
  }
  return resources;
}

function printApiHelp(contract: ApiContract): void {
  const resources = [...canonicalResourceMap(contract)].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  process.stdout.write(`Usage: langfuse-cli api <resource> <action> [options]

API snapshot: ${contract.apiVersion}

Resources:
${resources
  .map(
    ([resource, operations]) =>
      `  ${resource}${operations.some((operation) => operation.deprecated) ? " [contains deprecated actions]" : ""}`,
  )
  .join("\n")}

Discovery:
  api help [resource] [action]
  api schema --json          Machine-readable command schema
  api __schema --json        Legacy command alias
  api versions list          Bundled historical snapshots
  Path commands are canonical; OpenAPI tag and route-version aliases also work

Action options:
  --body-json <json>         Lossless JSON request body
  --body-file <path|->       Read JSON body from file or stdin
  --all                      Fetch every page of a paginated list (--max-items caps it)
  --json                     Stable JSON response envelope
  --curl                     Print curl without executing
`);
}

function printResourceHelp(contract: ApiContract, resource: string): void {
  const bindings = resourceMap(contract).get(resource);
  if (!bindings) throw new CliError(`Unknown API resource: ${resource}`);
  process.stdout.write(`Usage: langfuse-cli api ${resource} <action> [options]

Actions:
${bindings
  .map(
    (binding) => {
      const label = `${binding.action}${binding.alias ? " [alias]" : ""}${binding.operation.deprecated ? " [deprecated]" : ""}`;
      return `  ${label.padEnd(43)} ${binding.operation.method} ${binding.operation.path}`;
    },
  )
  .join("\n")}
`);
}

function explicitDeprecationNote(operation: ApiOperation): string | undefined {
  const description = operation.description?.trim();
  if (!description || !/^(?:\*\*)?deprecated\b/i.test(description)) {
    return undefined;
  }
  return description
    .split(/\n\s*\n/, 1)[0]
    .replace(/^\*\*Deprecated\.\*\*\s*/i, "")
    .replace(/^Deprecated\.?\s*/i, "")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

export function assertOperationCallable(
  operation: ApiOperation,
  apiVersion: string,
): void {
  if (!operation.deprecated) return;
  const note = explicitDeprecationNote(operation);
  throw new CliError(
    `Cannot call deprecated API operation "${operation.command.resource} ${operation.command.action}" (${operation.method} ${operation.path}) in API ${apiVersion}.` +
      (note ? ` ${note}` : " No replacement is declared in its OpenAPI description.") +
      ` Use "langfuse-cli api help ${operation.command.resource}" or "langfuse-cli api schema --json" to find supported operations.`,
  );
}

function kindLabel(kind: ValueKind): string {
  if (kind === "array") return "value (repeatable)";
  return kind === "any" ? "json" : kind;
}

function flagUsage(name: string, kind: ValueKind): string {
  return kind === "boolean"
    ? `--${name}[=true|false] / --no-${name}`
    : `--${name} <${kindLabel(kind)}>`;
}

function clip(text: string, max = 100): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function annotate(
  base: string,
  values?: Array<string | number>,
  description?: string,
): string {
  const notes = [
    ...(values?.length ? [`one of: ${values.join(", ")}`] : []),
    ...(description ? [clip(description)] : []),
  ];
  if (notes.length === 0) return `  ${base}`;
  return `  ${base.padEnd(38)} ${notes.join(" — ")}`;
}

function kindText(kind: ValueKind, itemKind?: ValueKind): string {
  if (kind === "array") return `array<${kindText(itemKind ?? "string")}>`;
  return kind === "any" ? "json" : kind;
}

function bodyFieldsSection(operation: ApiOperation): string {
  const body = operation.requestBody;
  if (!body || body.fieldFlags || body.fields.length === 0) return "";
  const fieldLine = (field: ApiBodyField, indent: string) =>
    annotate(
      `${indent}${field.name.padEnd(18)} ${kindText(field.kind, field.itemKind)}${field.required ? " (required)" : ""}`,
      field.enum,
      field.description,
    );
  if (body.discriminator) {
    // These fields are typed as flags, so show flag spellings (--commit-message),
    // not JSON wire keys (commitMessage).
    const groups = Object.entries(body.discriminator.variants).map(
      ([variant, fields]) =>
        `  --${body.discriminator!.cliName} ${variant}:\n${fields
          .filter((field) => field.name !== body.discriminator!.field)
          .map((field) =>
            annotate(
              `  ${flagUsage(field.cliName, field.kind)}${field.required ? " (required)" : ""}`,
              field.enum,
              field.description,
            ),
          )
          .join("\n")}`,
    );
    return `\nRequest body fields (field flags supported; select the variant with --${body.discriminator.cliName}, or pass --body-json):\n${groups.join("\n")}\n`;
  }
  const lines = body.fields.map((field) => fieldLine(field, ""));
  const unionNote = body.union
    ? "\n  This body is a union of shapes; fields are merged across variants. See the API reference for exact shapes.\n"
    : "";
  return `\nRequest body fields (pass with --body-json or --body-file):\n${lines.join("\n")}\n${unionNote}`;
}

function printOperationHelp(operation: ApiOperation): void {
  const positionals = operation.pathParameterOrder
    .map((name) => `<${name}>`)
    .join(" ");
  const lines: string[] = [];
  for (const parameter of operation.parameters) {
    if (parameter.location === "path") continue;
    lines.push(
      annotate(
        `${flagUsage(parameter.cliName, parameter.kind)}${parameter.required ? " (required)" : ""}`,
        parameter.enum,
        parameter.description,
      ),
    );
  }
  if (operation.requestBody?.fieldFlags) {
    for (const field of operation.requestBody.fields) {
      lines.push(
        annotate(
          `${flagUsage(field.cliName, field.kind)}${field.required ? " (required)" : ""}`,
          field.enum,
          field.description,
        ),
      );
    }
  }
  if (operation.requestBody) {
    lines.push("  --body-json <json>             Lossless JSON body");
    lines.push("  --body-file <path|->          JSON body from file or stdin");
  }
  if (operation.pagination) {
    lines.push(
      `  --all                          Fetch every ${operation.pagination === "cursor" ? "cursor page" : "page"} (bounded by --max-items)`,
    );
    lines.push(
      `  --max-items <number>           Item cap for --all (default ${DEFAULT_MAX_ITEMS})`,
    );
  }
  process.stdout.write(`Usage: langfuse-cli api ${operation.command.resource} ${operation.command.action}${positionals ? ` ${positionals}` : ""} [options]

${operation.summary ?? operation.operationId}
${operation.description ? `\n${operation.description}\n` : ""}
${
  operation.deprecated
    ? `\nDEPRECATED\nThis operation is discoverable but cannot be called by this CLI.${explicitDeprecationNote(operation) ? ` ${explicitDeprecationNote(operation)}` : ""}\n`
    : ""
}${bodyFieldsSection(operation)}
Options:
${lines.length ? lines.join("\n") : "  (no operation-specific options)"}
  --json                         JSON response envelope
  --curl                         Print curl without executing
`);
}

export function operationByCommand(
  contract: ApiContract,
  resource: string,
  action: string,
): ApiOperation {
  const operation = contract.operations.find(
    (candidate) => {
      if (
        candidate.command.resource === resource &&
        candidate.command.action === action
      ) {
        return true;
      }
      return candidate.command.aliases?.some(
        (alias) => alias.resource === resource && alias.action === action,
      );
    },
  );
  if (!operation) {
    if (!resourceMap(contract).has(resource)) {
      throw new CliError(`Unknown API resource: ${resource}`);
    }
    throw new CliError(`Unknown action ${resource} ${action}`);
  }
  return operation;
}

function parseJsonValue(value: string, kind?: ValueKind): JsonValue {
  if (kind === "string") return value;
  if (kind === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
    throw new CliError(`Expected boolean, got ${value}`);
  }
  if (kind === "number") {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new CliError(`Expected number, got ${value}`);
    return number;
  }
  if (kind === "object" || kind === "array" || kind === "null") {
    let parsed: JsonValue;
    try {
      parsed = JSON.parse(value) as JsonValue;
    } catch {
      throw new CliError(`Expected ${kind} as JSON, got ${value}`);
    }
    if (
      (kind === "object" &&
        (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))) ||
      (kind === "array" && !Array.isArray(parsed)) ||
      (kind === "null" && parsed !== null)
    ) {
      throw new CliError(`Expected ${kind} as JSON, got ${value}`);
    }
    return parsed;
  }
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return value;
  }
}

function addParameterValue(
  input: ApiCallInput,
  parameter: ApiParameter,
  raw: string | undefined,
  typedFlag: string,
): void {
  const target =
    parameter.location === "path"
      ? input.path
      : parameter.location === "query"
        ? input.query
        : parameter.location === "header"
          ? input.headers
          : input.cookies;
  if (raw === undefined && parameter.kind !== "boolean") {
    throw new CliError(`--${typedFlag} requires a value`);
  }
  const parsed = parseJsonValue(raw ?? "true", parameter.itemKind ?? parameter.kind);
  if (parameter.kind === "array") {
    const existing = target[parameter.name];
    if (Array.isArray(existing)) existing.push(parsed);
    else target[parameter.name] = [parsed];
  } else {
    target[parameter.name] = parsed;
  }
}

function kindMatches(value: JsonValue, kind: ValueKind | undefined): boolean {
  if (kind === undefined || kind === "any") return true;
  if (kind === "string") return typeof value === "string";
  if (kind === "number") return typeof value === "number";
  if (kind === "boolean") return typeof value === "boolean";
  if (kind === "null") return value === null;
  if (kind === "array") return Array.isArray(value);
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function kindArticle(kind: ValueKind): string {
  if (kind === "object" || kind === "array") return `an ${kind}`;
  if (kind === "null") return "null";
  return `a ${kind}`;
}

function setBodyValue(
  body: Record<string, JsonValue>,
  raw: string | undefined,
  field: ApiBodyField,
): void {
  if (field.kind === "array") {
    // A JSON array value appends all its elements; otherwise the value is
    // one item. Both forms are repeatable and validated per item.
    let bulk: JsonValue[] | undefined;
    if (raw !== undefined) {
      try {
        const parsed = JSON.parse(raw) as JsonValue;
        if (Array.isArray(parsed)) bulk = parsed;
      } catch {}
    }
    const items = bulk ?? [parseJsonValue(raw ?? "true", field.itemKind)];
    if (field.itemKind !== undefined && field.itemKind !== "any") {
      items.forEach((item, index) => {
        if (!kindMatches(item, field.itemKind)) {
          throw new CliError(
            `--${field.cliName}: array item ${index} must be ${kindArticle(field.itemKind!)}`,
          );
        }
      });
    }
    const existing = body[field.name];
    if (Array.isArray(existing)) existing.push(...items);
    else body[field.name] = items;
    return;
  }
  body[field.name] = parseJsonValue(raw ?? "true", field.kind);
}

function splitOption(token: string): { name: string; inline?: string; negated: boolean } {
  const separator = token.indexOf("=");
  const rawName = separator === -1 ? token.slice(2) : token.slice(2, separator);
  return {
    name: rawName.startsWith("no-") ? rawName.slice(3) : rawName,
    ...(separator === -1 ? {} : { inline: token.slice(separator + 1) }),
    negated: rawName.startsWith("no-"),
  };
}

function bodyPlaceholder(field: ApiBodyField): string {
  if (field.enum?.length) return `"${field.enum.join("|")}"`;
  if (field.kind === "number") return "0";
  if (field.kind === "boolean") return "true";
  if (field.kind === "array") return "[…]";
  if (field.kind === "object") return "{…}";
  if (field.kind === "null") return "null";
  return `"…"`;
}

// Shape sketch for body-channel usage errors, derived from the contract's
// required fields. The … placeholders make it read as a shape, not as a
// valid payload (union bodies merge required fields across variants).
function bodyHint(operation: ApiOperation): string {
  const body = operation.requestBody;
  if (!body) return "";
  const required = body.fields.filter((field) => field.required);
  if (required.length === 0) return "";
  const sketch = required
    .map((field) => `"${field.name}":${bodyPlaceholder(field)}`)
    .join(",");
  const unionNote = body.discriminator
    ? `\n(or use field flags directly by selecting a variant: --${body.discriminator.cliName} ${Object.keys(body.discriminator.variants).join("|")} …)`
    : body.union
      ? `\n(union body: required fields are merged across variants — see \`langfuse-cli api help ${operation.command.resource} ${operation.command.action}\`)`
      : "";
  return `, e.g.\n\n  --body-json '{${sketch}}'\n${unionNote}`;
}

async function readBodyFile(path: string): Promise<JsonValue> {
  let text: string;
  try {
    text =
      path === "-" ? await streamText(process.stdin) : await readFile(path, "utf8");
  } catch (error) {
    throw new CliError(
      `Cannot read body file ${path}: ${error instanceof Error ? error.message : String(error)}`,
      EXIT_LOCAL,
    );
  }
  try {
    return JSON.parse(text) as JsonValue;
  } catch (error) {
    throw new CliError(
      `Invalid JSON in ${path === "-" ? "stdin" : path}: ${error instanceof Error ? error.message : String(error)}`,
      EXIT_LOCAL,
    );
  }
}

export async function parseOperationInput(
  operation: ApiOperation,
  tokens: string[],
): Promise<ApiCallInput> {
  const discriminator = operation.requestBody?.fieldFlags
    ? undefined
    : operation.requestBody?.discriminator;
  if (discriminator) {
    // Phase 1: a cheap scan for the discriminator flag and the lossless body
    // channel only — nothing else is interpreted. Runs solely for operations
    // whose contract carries a discriminated union.
    let selected: string | undefined;
    let bodyChannel = false;
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (!token.startsWith("--")) continue;
      const equals = token.indexOf("=");
      const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
      if (name === "body-json" || name === "body-file") bodyChannel = true;
      if (name === discriminator.cliName) {
        const value = equals === -1 ? tokens[index + 1] : token.slice(equals + 1);
        if (value !== undefined && !value.startsWith("--")) selected = value;
      }
    }
    if (selected !== undefined && bodyChannel) {
      throw new CliError(
        "Do not mix --body-json/--body-file with body field flags",
      );
    }
    if (selected !== undefined && !bodyChannel) {
      const fields = discriminator.variants[selected];
      if (!fields) {
        throw new CliError(
          `--${discriminator.cliName} must be one of: ${Object.keys(discriminator.variants).join(", ")} (got "${selected}")`,
        );
      }
      // Phase 2: the ordinary single-pass parse, against the selected
      // variant's fields — branch-specific kinds and required set apply.
      return parseOperationInput(
        {
          ...operation,
          requestBody: {
            ...operation.requestBody!,
            fieldFlags: true,
            fields,
          },
        },
        tokens,
      );
    }
  }
  const input: ApiCallInput = {
    path: {},
    query: {},
    headers: {},
    cookies: {},
  };
  const parameterByFlag = new Map<string, ApiParameter>();
  for (const parameter of operation.parameters) {
    if (parameter.location !== "path") {
      parameterByFlag.set(parameter.cliName, parameter);
      for (const alias of parameter.cliAliases ?? []) {
        parameterByFlag.set(alias, parameter);
      }
    }
  }
  const positionals: string[] = [];
  let fieldBody: Record<string, JsonValue> | undefined;
  let completeBody: JsonValue | undefined;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const option = splitOption(token);
    const parameter = parameterByFlag.get(option.name);
    const bodyField = operation.requestBody?.fieldFlags
      ? operation.requestBody.fields.find(
          (candidate) => candidate.cliName === option.name.split(".")[0],
        )
      : undefined;
    if (bodyField && option.name.includes(".")) {
      throw new CliError(
        `Nested body option --${option.name} is unsupported; pass --${bodyField.cliName} with a JSON object or use --body-json`,
      );
    }
    const isBoolean =
      parameter?.kind === "boolean" || bodyField?.kind === "boolean";
    let raw = option.inline;
    if (
      raw === undefined &&
      !isBoolean &&
      tokens[index + 1] !== undefined &&
      !tokens[index + 1].startsWith("--")
    ) {
      raw = tokens[++index];
    }
    if (option.name === "body-json") {
      if (raw === undefined) throw new CliError("--body-json requires a value");
      try {
        completeBody = JSON.parse(raw) as JsonValue;
      } catch (error) {
        throw new CliError(
          `Invalid --body-json: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      continue;
    }
    if (option.name === "body-file") {
      if (raw === undefined) throw new CliError("--body-file requires a path or -");
      completeBody = await readBodyFile(raw);
      continue;
    }
    if (parameter) {
      if (option.negated && parameter.kind !== "boolean") {
        throw new CliError(`--no-${option.name} is only valid for boolean options`);
      }
      addParameterValue(input, parameter, option.negated ? "false" : raw, option.name);
      continue;
    }
    if (!operation.requestBody) {
      throw new CliError(`Unknown option --${option.name}`);
    }
    if (!operation.requestBody.fieldFlags) {
      const disc = operation.requestBody.discriminator;
      throw new CliError(
        disc
          ? `${operation.operationId} field flags require --${disc.cliName} (one of: ${Object.keys(disc.variants).join(", ")}) to select the body variant, or use --body-json/--body-file${bodyHint(operation)}`
          : `${operation.operationId} requires --body-json or --body-file for request bodies${bodyHint(operation)}`,
      );
    }
    const field = bodyField;
    if (!field) throw new CliError(`Unknown option --${option.name}`);
    if (option.negated && field.kind !== "boolean") {
      throw new CliError(`--no-${option.name} is only valid for boolean options`);
    }
    if (raw === undefined && field.kind !== "boolean") {
      throw new CliError(`--${option.name} requires a value`);
    }
    fieldBody ??= {};
    setBodyValue(fieldBody, option.negated ? "false" : raw, field);
  }
  if (completeBody !== undefined && fieldBody !== undefined) {
    throw new CliError("Do not mix --body-json/--body-file with body field flags");
  }
  if (positionals.length !== operation.pathParameterOrder.length) {
    throw new CliError(
      `${operation.operationId} expects ${operation.pathParameterOrder.length} path argument(s), got ${positionals.length}`,
    );
  }
  for (let index = 0; index < operation.pathParameterOrder.length; index++) {
    const name = operation.pathParameterOrder[index];
    const parameter = operation.parameters.find(
      (candidate) => candidate.location === "path" && candidate.name === name,
    );
    if (!parameter) throw new CliError(`Missing path parameter contract: ${name}`);
    input.path[name] = parseJsonValue(positionals[index], parameter.kind);
  }
  for (const parameter of operation.parameters) {
    const target =
      parameter.location === "path"
        ? input.path
        : parameter.location === "query"
          ? input.query
          : parameter.location === "header"
            ? input.headers
            : input.cookies;
    if (parameter.required && target[parameter.name] === undefined) {
      throw new CliError(`Missing required option --${parameter.cliName}`);
    }
  }
  let body = completeBody !== undefined ? completeBody : fieldBody;
  if (completeBody === undefined && operation.requestBody?.fieldFlags) {
    const missing = operation.requestBody.fields
      .filter((field) => field.required && fieldBody?.[field.name] === undefined)
      .map((field) => `--${field.cliName}`);
    if (missing.length > 0) {
      throw new CliError(`Missing required body option(s): ${missing.join(", ")}`);
    }
    if (body === undefined && operation.requestBody.required) body = {};
  }
  if (operation.requestBody?.required && body === undefined) {
    throw new CliError(
      `${operation.operationId} requires a request body${bodyHint(operation)}`,
    );
  }
  if (body !== undefined) input.body = body;
  return input;
}

const DEFAULT_MAX_ITEMS = 1000;
// Bounds the number of requests one --all run may issue, independently of
// --max-items: a small --limit must not turn an item cap into a request
// storm against the server.
const MAX_PAGES = 100;

export interface PaginationFlags {
  tokens: string[];
  all: boolean;
  maxItems?: number;
}

export function extractPaginationFlags(tokens: string[]): PaginationFlags {
  const rest: string[] = [];
  let all = false;
  let maxItems: number | undefined;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const equals = token.indexOf("=");
    const name = equals === -1 ? token : token.slice(0, equals);
    if (name === "--all") {
      all = true;
      continue;
    }
    if (name === "--max-items") {
      const value = equals === -1 ? tokens[++index] : token.slice(equals + 1);
      if (value === undefined || value.startsWith("--")) {
        throw new CliError("--max-items requires a value");
      }
      maxItems = Number(value);
      if (!Number.isInteger(maxItems) || maxItems <= 0) {
        throw new CliError("--max-items must be a positive integer");
      }
      continue;
    }
    rest.push(token);
  }
  return { tokens: rest, all, maxItems };
}

export function assertPaginationUsage(
  operation: ApiOperation,
  flags: PaginationFlags,
  curl: boolean,
): void {
  if (!flags.all) {
    if (flags.maxItems !== undefined) {
      throw new CliError("--max-items requires --all");
    }
    return;
  }
  if (!operation.pagination) {
    throw new CliError(
      `${operation.command.resource} ${operation.command.action} is not a paginated list operation; --all is unsupported`,
    );
  }
  if (curl) {
    throw new CliError("--all cannot be combined with --curl");
  }
}

interface PageClient {
  call(operation: ApiOperation, input: ApiCallInput): Promise<ApiResult>;
}

export async function callAllPages(
  client: PageClient,
  operation: ApiOperation,
  input: ApiCallInput,
  maxItems = DEFAULT_MAX_ITEMS,
): Promise<ApiResult> {
  const items: JsonValue[] = [];
  let pages = 0;
  let truncated = false;
  let totalItems: number | undefined;
  let last: ApiResult;
  if (operation.pagination === "page" && input.query.page === undefined) {
    input.query.page = 1;
  }
  for (;;) {
    const result = await client.call(operation, input);
    if (!result.ok) {
      if (pages > 0) {
        process.stderr.write(
          `--all aborted after ${pages} page(s) and ${items.length} item(s): HTTP ${result.status}\n`,
        );
      }
      return result;
    }
    last = result;
    pages++;
    const record =
      result.body && typeof result.body === "object" && !Array.isArray(result.body)
        ? (result.body as Record<string, JsonValue>)
        : undefined;
    const data =
      record && Array.isArray(record.data) ? (record.data as JsonValue[]) : undefined;
    // Not a data-list response shape: behave like a plain single call.
    if (data === undefined) {
      if (pages === 1) return result;
      break;
    }
    items.push(...data);
    const meta = (record?.meta ?? record?.pagination) as
      | Record<string, JsonValue>
      | undefined;
    let hasMore = false;
    let nextCursor: string | undefined;
    if (operation.pagination === "cursor") {
      nextCursor =
        typeof meta?.cursor === "string" && meta.cursor.length > 0
          ? meta.cursor
          : undefined;
      hasMore = nextCursor !== undefined;
    } else {
      const page = Number(meta?.page ?? input.query.page);
      const totalPages = Number(meta?.totalPages);
      if (Number.isFinite(Number(meta?.totalItems))) {
        totalItems = Number(meta?.totalItems);
      }
      hasMore = Number.isFinite(totalPages) && page < totalPages;
      if (hasMore) input.query.page = page + 1;
    }
    if (items.length >= maxItems) {
      truncated = hasMore || items.length > maxItems;
      items.length = Math.min(items.length, maxItems);
      if (truncated) {
        process.stderr.write(
          `--all stopped at ${items.length} item(s) (--max-items ${maxItems}); more data is available\n`,
        );
      }
      break;
    }
    if (!hasMore) break;
    if (pages >= MAX_PAGES) {
      truncated = true;
      process.stderr.write(
        `--all stopped after ${MAX_PAGES} requests with ${items.length} item(s); raise --limit for larger pages or --max-items to continue\n`,
      );
      break;
    }
    if (operation.pagination === "cursor") input.query.cursor = nextCursor!;
  }
  return {
    status: last.status,
    headers: last.headers,
    ok: true,
    body: {
      data: items,
      meta: {
        pages,
        fetchedItems: items.length,
        ...(totalItems !== undefined ? { totalItems } : {}),
        truncated,
      },
    },
  };
}

export function schemaOutput(contract: ApiContract) {
  return {
    schemaVersion: 1,
    apiVersion: contract.apiVersion,
    sourceSha256: contract.sourceSha256,
    resources: [...canonicalResourceMap(contract)].map(([name, operations]) => ({
      name,
      actions: operations.map((operation) => ({
        name: operation.command.action,
        aliases: operation.command.aliases ?? [],
        operationId: operation.operationId,
        method: operation.method,
        path: operation.path,
        deprecated: Boolean(operation.deprecated),
        ...(operation.pagination ? { pagination: operation.pagination } : {}),
        auth: operation.auth,
        pathParameterOrder: operation.pathParameterOrder,
        parameters: operation.parameters,
        ...(operation.requestBody
          ? { requestBody: operation.requestBody }
          : {}),
        ...(operation.summary ? { summary: operation.summary } : {}),
        ...(operation.description
          ? { description: operation.description }
          : {}),
      })),
    })),
  };
}

export async function writeResult(
  result: ApiResult,
  config: RuntimeConfig,
  command = "api",
  meta: Meta = {},
): Promise<void> {
  if (config.outFile) {
    const content =
      result.body === null
        ? ""
        : typeof result.body === "string"
        ? result.body
        : JSON.stringify(result.body, null, 2);
    try {
      await writeFile(config.outFile, content ?? "");
    } catch (error) {
      throw new CliError(
        `Cannot write --out-file ${config.outFile}: ${error instanceof Error ? error.message : String(error)}`,
        EXIT_LOCAL,
      );
    }
  } else {
    process.stdout.write(
      renderSuccess(config.outputMode, command, result.body, {
        status: result.status,
        profile: config.profile,
        host: config.host,
        ...meta,
      }),
    );
  }
  if (!result.ok) process.exitCode = EXIT_HTTP;
}

export async function runApi(
  config: RuntimeConfig,
  args: string[],
  providedCatalog?: ApiContractCatalog,
): Promise<void> {
  const catalog = providedCatalog ?? (await loadContractCatalog());
  if (args[0] === "versions") {
    const action = args[1] ?? "list";
    if (action === "list") {
      process.stdout.write(
        `${catalog.versions.map((entry) => entry.version).join("\n")}\n`,
      );
      return;
    }
    if (action === "current") {
      const resolved = await resolveContractVersion({
        requested: config.apiVersion,
        host: config.host,
        timeoutMs: config.timeoutMs,
        catalog,
      });
      process.stdout.write(`${resolved.version}\n`);
      return;
    }
    if (action === "detect") {
      const resolved = await resolveContractVersion({
        requested: "auto",
        host: config.host,
        timeoutMs: config.timeoutMs,
        catalog,
      });
      process.stdout.write(
        `${resolved.detected} -> ${resolved.version}\n`,
      );
      return;
    }
    throw new CliError(`Unknown versions action: ${action}`);
  }
  const resolved = await resolveContractVersion({
    requested: config.apiVersion,
    host: config.host,
    timeoutMs: config.timeoutMs,
    catalog,
  });
  const contract = await loadApiContract(resolved.version);
  if (
    args.length === 0 ||
    (args[0] === "help" && args.length === 1) ||
    args[0] === "--help" ||
    args[0] === "-h"
  ) {
    printApiHelp(contract);
    return;
  }
  if (["schema", "__schema", "__spec"].includes(args[0])) {
    const schema = schemaOutput(contract);
    if (config.outputMode === "table") printApiHelp(contract);
    else {
      process.stdout.write(
        renderSuccess(config.outputMode, "api.schema", schema, {
          profile: config.profile,
          host: config.host,
        }),
      );
    }
    return;
  }
  if (args[0] === "help") {
    if (!args[1]) printApiHelp(contract);
    else if (!args[2]) printResourceHelp(contract, args[1]);
    else printOperationHelp(operationByCommand(contract, args[1], args[2]));
    return;
  }
  const resource = args[0];
  if (!args[1] || args[1] === "help" || args[1] === "--help" || args[1] === "-h") {
    printResourceHelp(contract, resource);
    return;
  }
  const operation = operationByCommand(contract, resource, args[1]);
  if (args[2] === "help" || args[2] === "--help" || args[2] === "-h") {
    printOperationHelp(operation);
    return;
  }
  assertOperationCallable(operation, contract.apiVersion);
  const pagination = extractPaginationFlags(args.slice(2));
  assertPaginationUsage(operation, pagination, config.curl);
  const input = await parseOperationInput(operation, pagination.tokens);
  // Credentials are resolved here, at the last possible moment, so every
  // discovery path above stays usable without a configured connection.
  const connection = await connect(config);
  const client = createApiClient({
    host: connection.host,
    publicKey: connection.publicKey,
    secretKey: connection.secretKey,
    timeoutMs: config.timeoutMs,
  });
  if (config.curl) {
    process.stdout.write(
      `${renderCurl(client.prepare(operation, input), { showSecrets: config.showSecrets })}\n`,
    );
    return;
  }
  const started = Date.now();
  const result = pagination.all
    ? await callAllPages(client, operation, input, pagination.maxItems)
    : await client.call(operation, input);
  await writeResult(
    result,
    config,
    `api.${operation.command.resource}.${operation.command.action}`,
    { elapsedMs: Date.now() - started, profile: connection.profile },
  );
}

/** Options that exist only inside a connection subcommand. */
const SUBCOMMAND_BOOLEANS = new Set(["secret-key-stdin", "no-verify"]);

interface SubcommandArgs {
  values: Record<string, string>;
  booleans: Set<string>;
  positional: string[];
}

function parseSubcommandArgs(args: string[]): SubcommandArgs {
  const values: Record<string, string> = {};
  const booleans = new Set<string>();
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    const name = flagKey(equals === -1 ? token : token.slice(0, equals));
    if (SUBCOMMAND_BOOLEANS.has(name)) {
      booleans.add(name);
      continue;
    }
    const value = equals === -1 ? args[index + 1] : token.slice(equals + 1);
    if (value === undefined || (equals === -1 && value.startsWith("--"))) {
      throw new CliError(`--${name} requires a value`);
    }
    values[name] = value;
    if (equals === -1) index++;
  }
  return { values, booleans, positional };
}

function commandContext(
  config: RuntimeConfig,
  sub: SubcommandArgs,
): CommandContext {
  return {
    config: config.configFile,
    store: config.store,
    outputMode: config.outputMode,
    timeoutMs: config.timeoutMs,
    environment: config.environment,
    profileFlag: config.profileFlag,
    hostFlag: config.hostFlag,
    publicKeyFlag: config.publicKeyFlag,
    flags: sub.values,
    booleans: sub.booleans,
  };
}

function requirePositional(sub: SubcommandArgs, usage: string): string {
  const name = sub.positional[1];
  if (!name) throw new CliError(`Usage: ${usage}`, EXIT_USAGE);
  return name;
}

async function runAuth(
  config: RuntimeConfig,
  sub: SubcommandArgs,
): Promise<void> {
  const context = commandContext(config, sub);
  switch (sub.positional[0]) {
    case "login":
      return authLogin(context);
    case "check":
      return authCheck(context);
    case "logout":
      return authLogout(context);
    default:
      throw new CliError(
        "Usage: langfuse-cli auth <login|check|logout>",
        EXIT_USAGE,
      );
  }
}

async function runProfile(
  config: RuntimeConfig,
  sub: SubcommandArgs,
): Promise<void> {
  const context = commandContext(config, sub);
  switch (sub.positional[0]) {
    case "add":
      return profileAdd(
        context,
        requirePositional(
          sub,
          "langfuse-cli profile add <name> --host <url> --public-key <pk>",
        ),
      );
    case "update":
      return profileUpdate(
        context,
        requirePositional(
          sub,
          "langfuse-cli profile update <name> [--host <url>] [--public-key <pk>]",
        ),
      );
    case "list":
      return profileList(context);
    case "show":
      return profileShow(context, sub.positional[1]);
    case "use":
      return profileUse(
        context,
        requirePositional(sub, "langfuse-cli profile use <name>"),
      );
    case "remove":
      return profileRemove(
        context,
        requirePositional(sub, "langfuse-cli profile remove <name>"),
      );
    default:
      throw new CliError(
        "Usage: langfuse-cli profile <add|update|list|show|use|remove>",
        EXIT_USAGE,
      );
  }
}

async function runConfig(
  config: RuntimeConfig,
  sub: SubcommandArgs,
): Promise<void> {
  const context = commandContext(config, sub);
  switch (sub.positional[0]) {
    case "path":
      return configPath(context);
    case "show":
      return configShow(context);
    default:
      throw new CliError("Usage: langfuse-cli config <path|show>", EXIT_USAGE);
  }
}

async function runSkills(
  config: RuntimeConfig,
  sub: SubcommandArgs,
): Promise<void> {
  if (sub.positional[0] !== "install") {
    throw new CliError(
      "Usage: langfuse-cli skills install [--target all|codex|claude]",
      EXIT_USAGE,
    );
  }
  const results = await installSkills(parseSkillTarget(sub.values.target));
  if (config.outputMode === "table") {
    process.stdout.write(
      `${renderTable(
        ["target", "installed", "updated", "unchanged", "directory"],
        results.map((result) => [
          result.target,
          String(result.installed.length),
          String(result.updated.length),
          String(result.unchanged.length),
          result.directory,
        ]),
      )}\n`,
    );
    return;
  }
  process.stdout.write(
    renderSuccess(config.outputMode, "skills.install", results),
  );
}

export async function run(argv: string[]): Promise<void> {
  const raw = argv.slice(2);

  // Completion runs on every keypress, so it takes a deliberately short path:
  // it reads the config for profile names but never probes the credential
  // store, and it consumes the raw argv because global options must stay
  // visible to decide what the cursor is completing. Any failure yields no
  // candidates rather than an error, which would corrupt the shell's display.
  if (raw[0] === "__complete") {
    try {
      const configPathIndex = raw.indexOf("--config-file");
      const config = await Config.load(
        (configPathIndex !== -1 ? raw[configPathIndex + 1] : undefined) ??
          defaultConfigPath(),
      );
      process.stdout.write(
        renderCompletions(await complete(raw.slice(1), { config })),
      );
    } catch {
      process.stdout.write(renderCompletions([]));
    }
    return;
  }

  try {
    const globals = extractGlobals(raw);
    const [command, ...args] = globals.args;
    if (command === "--version") {
      process.stdout.write(`${packageJson.version}\n`);
      return;
    }
    if (!command || command === "--help" || command === "-h") {
      printHelp();
      return;
    }
    if (command === "get-skill") {
      throw new CliError(
        "get-skill was replaced by `langfuse-cli skills install`, which installs the bundled SKILL.md together with every references/*.md it links to.",
        EXIT_USAGE,
      );
    }
    const config = await runtimeConfig(globals);
    const sub = parseSubcommandArgs(args);
    switch (command) {
      case "api":
        return await runApi(config, args);
      case "init":
        return await init(commandContext(config, sub));
      case "doctor":
        return await doctor(commandContext(config, sub));
      case "auth":
        return await runAuth(config, sub);
      case "profile":
        return await runProfile(config, sub);
      case "config":
        return await runConfig(config, sub);
      case "skills":
        return await runSkills(config, sub);
      case "completion":
        process.stdout.write(
          renderCompletionScript(parseCompletionShell(sub.positional[0])),
        );
        return;
      default:
        throw new CliError(`Unknown command: ${command}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = error instanceof CliError ? error.exitCode : 1;
  }
}
