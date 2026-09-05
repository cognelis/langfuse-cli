// Read-only connection diagnosis.
//
// The report is an ordered array so a script can index checks positionally and
// a human reads them in the order they actually fail: nothing downstream is
// meaningful until the step before it passes. A completed run always writes the
// full report, then exits with the code matching the first failure.
import { EXIT_CONFIG, EXIT_NETWORK } from "./errors";
import { renderTable } from "./table";

export type DoctorStatus = "pass" | "fail" | "skipped";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  message: string;
}

export const CHECK_VERSION = 0;
export const CHECK_CONFIGURATION = 1;
export const CHECK_CREDENTIALS = 2;
export const CHECK_API = 3;
export const CHECK_AUTHENTICATION = 4;

const CHECK_NAMES = [
  "version",
  "configuration",
  "credentials",
  "api",
  "authentication",
] as const;

export class DoctorReport {
  private readonly checks: DoctorCheck[];

  constructor(version: string) {
    this.checks = [
      { name: "version", status: "pass", message: `langfuse-cli ${version}` },
      skipped("configuration", "connection target has not been checked"),
      skipped("credentials", "credentials have not been checked"),
      skipped("api", "API connectivity has not been checked"),
      skipped("authentication", "authentication has not been checked"),
    ];
  }

  pass(index: number, message: string): void {
    this.set(index, "pass", message);
  }

  fail(index: number, message: string): void {
    this.set(index, "fail", message);
  }

  get healthy(): boolean {
    return !this.checks.some((check) => check.status === "fail");
  }

  /**
   * Maps the first failing check to the exit-code contract: a configuration,
   * credential or authentication problem is a config failure; an unreachable
   * API is a network failure.
   */
  get exitCode(): number {
    const failed = this.checks.findIndex((check) => check.status === "fail");
    if (failed === -1) return 0;
    return failed === CHECK_API ? EXIT_NETWORK : EXIT_CONFIG;
  }

  toJSON(): { healthy: boolean; checks: DoctorCheck[] } {
    return { healthy: this.healthy, checks: this.checks.map((check) => ({ ...check })) };
  }

  /**
   * Human-readable form; the machine-readable form is the JSON envelope.
   *
   * A plain status column rather than symbols, so the report reads the same as
   * every other table and stays greppable.
   */
  render(): string {
    return renderTable(
      ["name", "status", "message"],
      this.checks.map((check) => [check.name, check.status, check.message]),
    );
  }

  private set(index: number, status: DoctorStatus, message: string): void {
    const name = CHECK_NAMES[index];
    if (!name) throw new Error(`Unknown doctor check index: ${index}`);
    this.checks[index] = { name, status, message };
  }
}

function skipped(name: string, message: string): DoctorCheck {
  return { name, status: "skipped", message };
}
