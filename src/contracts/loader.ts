import { readFile } from "node:fs/promises";

import { CliError, EXIT_CONFIG, EXIT_LOCAL, EXIT_NETWORK } from "../errors";
import type {
  ApiContract,
  ApiContractCatalog,
  ApiContractCatalogEntry,
} from "./types";

const CATALOG_URL = new URL("./contracts/catalog.json", import.meta.url);

/**
 * Raw contract sources, keyed by version, with "catalog" for the index.
 *
 * A single-file executable has no directory to read from, so its entry point
 * injects the bundled contracts here before dispatching. With nothing injected
 * the loader reads them from disk beside the built CLI, which is how the npm
 * installation works — that path is unchanged.
 *
 * Values stay as unparsed strings: holding 750 KB of contracts as text until a
 * command actually needs one keeps startup flat.
 */
let embeddedContracts: Readonly<Record<string, string>> | undefined;

export function setEmbeddedContracts(
  contracts: Readonly<Record<string, string>>,
): void {
  embeddedContracts = contracts;
}

async function readContractSource(
  key: string,
  url: URL,
  label: string,
): Promise<string> {
  const embedded = embeddedContracts?.[key];
  if (embedded !== undefined) return embedded;
  try {
    return await readFile(url, "utf8");
  } catch (error) {
    throw new CliError(
      `Cannot read the bundled ${label}: ${error instanceof Error ? error.message : String(error)}`,
      EXIT_LOCAL,
    );
  }
}

function parseVersion(version: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersion(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return left.localeCompare(right);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function requestedMajor(version: string): number | undefined {
  const match = /^v?(\d+)(?:\.x)?$/i.exec(version);
  return match ? Number(match[1]) : undefined;
}

function latestMajorEntry(
  entries: ApiContractCatalogEntry[],
  major: number,
): ApiContractCatalogEntry | undefined {
  return [...entries]
    .filter((entry) => parseVersion(entry.version)?.[0] === major)
    .sort((left, right) => compareVersion(right.version, left.version))[0];
}

export async function loadContractCatalog(): Promise<ApiContractCatalog> {
  const catalog = JSON.parse(
    await readContractSource("catalog", CATALOG_URL, "API contract catalog"),
  ) as ApiContractCatalog;
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.versions)) {
    throw new CliError("Invalid bundled API contract catalog", EXIT_LOCAL);
  }
  return catalog;
}

async function detectServerVersion(host: string, timeoutMs: number): Promise<string> {
  const url = `${host}/api/public/health`;
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new CliError(
      `API version detection failed: GET ${url}: ${cause}`,
      EXIT_NETWORK,
    );
  }
  if (!response.ok) {
    throw new CliError(
      `API version detection failed: GET ${url} returned HTTP ${response.status}`,
      EXIT_NETWORK,
    );
  }
  const body = (await response.json()) as { version?: unknown };
  if (typeof body.version !== "string" || !parseVersion(body.version)) {
    throw new CliError(
      `API version detection failed: GET ${url} returned no semantic version`,
      EXIT_NETWORK,
    );
  }
  return body.version.replace(/^v/, "");
}

function compatibleEntry(
  entries: ApiContractCatalogEntry[],
  serverVersion: string,
): ApiContractCatalogEntry | undefined {
  const target = parseVersion(serverVersion);
  if (!target) return undefined;
  return [...entries]
    .filter((entry) => {
      const version = parseVersion(entry.version);
      return version?.[0] === target[0] && compareVersion(entry.version, serverVersion) <= 0;
    })
    .sort((left, right) => compareVersion(right.version, left.version))[0];
}

export async function resolveContractVersion(params: {
  requested?: string;
  host: string;
  timeoutMs: number;
  catalog?: ApiContractCatalog;
}): Promise<{ catalog: ApiContractCatalog; version: string; detected?: string }> {
  const catalog = params.catalog ?? (await loadContractCatalog());
  const requested = params.requested ?? "latest";
  if (requested === "latest") {
    return { catalog, version: catalog.latest };
  }
  if (requested === "auto") {
    const detected = await detectServerVersion(params.host, params.timeoutMs);
    const exact = catalog.versions.find((entry) => entry.version === detected);
    const compatible = exact ?? compatibleEntry(catalog.versions, detected);
    if (!compatible) {
      throw new CliError(
        `No bundled API contract is compatible with detected server ${detected}`,
        EXIT_CONFIG,
      );
    }
    return { catalog, version: compatible.version, detected };
  }
  const exact = catalog.versions.find((entry) => entry.version === requested);
  if (exact) return { catalog, version: exact.version };
  const major = requestedMajor(requested);
  if (major !== undefined) {
    const latestInMajor = latestMajorEntry(catalog.versions, major);
    if (latestInMajor) return { catalog, version: latestInMajor.version };
    const availableMajors = [
      ...new Set(
        catalog.versions
          .map((entry) => parseVersion(entry.version)?.[0])
          .filter((value): value is number => value !== undefined),
      ),
    ].sort((left, right) => left - right);
    throw new CliError(
      `No bundled API contract for major version ${major}. Available majors: ${availableMajors.join(", ")}`,
      EXIT_CONFIG,
    );
  }
  throw new CliError(
    `Unknown API version ${requested}. Available: ${catalog.versions
      .map((entry) => entry.version)
      .join(", ")}`,
    EXIT_CONFIG,
  );
}

export async function loadApiContract(version: string): Promise<ApiContract> {
  const url = new URL(`./contracts/${encodeURIComponent(version)}.json`, import.meta.url);
  const contract = JSON.parse(
    await readContractSource(version, url, `API contract for ${version}`),
  ) as ApiContract;
  if (contract.schemaVersion !== 1 || contract.apiVersion !== version) {
    throw new CliError(`Invalid bundled API contract for ${version}`, EXIT_LOCAL);
  }
  return contract;
}
