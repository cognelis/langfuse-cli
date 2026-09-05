// Connection probes shared by `init`, `auth login`, `auth check` and `doctor`.
//
// A secret is verified before it is stored, so a typo fails at setup time
// instead of surfacing later as an opaque 401. Probe failures are returned as
// values rather than thrown: the callers report them as ordered diagnostics.
import packageJson from "../package.json";

const USER_AGENT = `langfuse-cli/${packageJson.version}`;

export interface ProbeResult {
  ok: boolean;
  status?: number;
  message: string;
}

export interface HealthResult extends ProbeResult {
  version?: string;
}

export interface AuthResult extends ProbeResult {
  /** Project names visible to the credential, for setup confirmation. */
  projects?: string[];
}

function basicAuth(publicKey: string, secretKey: string): string {
  return `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`;
}

function describeTransportError(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  if (/timed? ?out|abort/i.test(reason)) return "request timed out";
  return reason;
}

export async function checkHealth(
  host: string,
  timeoutMs: number,
): Promise<HealthResult> {
  const url = `${host.replace(/\/+$/, "")}/api/public/health`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { ok: false, message: `cannot reach ${url}: ${describeTransportError(error)}` };
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: `${url} responded ${response.status}`,
    };
  }
  let version: string | undefined;
  try {
    const body = (await response.json()) as { version?: unknown };
    if (typeof body.version === "string") version = body.version;
  } catch {
    // A healthy instance without a JSON body still counts as reachable.
  }
  return {
    ok: true,
    status: response.status,
    version,
    message: version ? `reachable, Langfuse ${version}` : "reachable",
  };
}

export async function checkAuth(
  host: string,
  publicKey: string,
  secretKey: string,
  timeoutMs: number,
): Promise<AuthResult> {
  const url = `${host.replace(/\/+$/, "")}/api/public/projects`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        accept: "application/json",
        authorization: basicAuth(publicKey, secretKey),
        "user-agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { ok: false, message: `cannot reach ${url}: ${describeTransportError(error)}` };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      status: response.status,
      message: `the key pair was rejected (${response.status}); check the public and secret key`,
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: `${url} responded ${response.status}`,
    };
  }
  let projects: string[] | undefined;
  try {
    const body = (await response.json()) as { data?: unknown };
    if (Array.isArray(body.data)) {
      projects = body.data
        .map((entry) =>
          entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string"
            ? (entry as { name: string }).name
            : undefined,
        )
        .filter((name): name is string => Boolean(name));
    }
  } catch {
    // Authentication already succeeded; a missing project list is not fatal.
  }
  return {
    ok: true,
    status: response.status,
    projects,
    message: projects?.length
      ? `authenticated, project access: ${projects.join(", ")}`
      : "authenticated",
  };
}
