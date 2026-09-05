import { describe, expect, test } from "bun:test";

import {
  CHECK_API,
  CHECK_AUTHENTICATION,
  CHECK_CONFIGURATION,
  CHECK_CREDENTIALS,
  DoctorReport,
} from "./doctor";

describe("doctor report", () => {
  test("has a stable, ordered shape a script can index", () => {
    const { checks } = new DoctorReport("1.2.3").toJSON();
    expect(checks.map((check) => check.name)).toEqual([
      "version",
      "configuration",
      "credentials",
      "api",
      "authentication",
    ]);
    expect(checks[0]).toMatchObject({ status: "pass", message: "langfuse-cli 1.2.3" });
  });

  test("unreached checks stay skipped rather than passing by default", () => {
    const { checks, healthy } = new DoctorReport("1.0.0").toJSON();
    expect(checks.slice(1).every((check) => check.status === "skipped")).toBe(true);
    // Nothing has failed yet, so a fresh report is healthy.
    expect(healthy).toBe(true);
  });

  test("any failure makes the report unhealthy", () => {
    const report = new DoctorReport("1.0.0");
    report.fail(CHECK_CREDENTIALS, "no key");
    expect(report.healthy).toBe(false);
  });

  test("maps the first failure to the exit-code contract", () => {
    const configuration = new DoctorReport("1.0.0");
    configuration.fail(CHECK_CONFIGURATION, "no profile");
    expect(configuration.exitCode).toBe(3);

    const credentials = new DoctorReport("1.0.0");
    credentials.fail(CHECK_CREDENTIALS, "no key");
    expect(credentials.exitCode).toBe(3);

    const api = new DoctorReport("1.0.0");
    api.fail(CHECK_API, "unreachable");
    expect(api.exitCode).toBe(4);

    const authentication = new DoctorReport("1.0.0");
    authentication.fail(CHECK_AUTHENTICATION, "rejected");
    expect(authentication.exitCode).toBe(3);
  });

  test("an earlier failure wins over a later one", () => {
    const report = new DoctorReport("1.0.0");
    report.fail(CHECK_CONFIGURATION, "no profile");
    report.fail(CHECK_API, "unreachable");
    // Configuration comes first, so it is what a caller should fix first.
    expect(report.exitCode).toBe(3);
  });

  test("a healthy report exits zero", () => {
    const report = new DoctorReport("1.0.0");
    report.pass(CHECK_CONFIGURATION, "ok");
    report.pass(CHECK_CREDENTIALS, "ok");
    report.pass(CHECK_API, "ok");
    report.pass(CHECK_AUTHENTICATION, "ok");
    expect(report.exitCode).toBe(0);
    expect(report.healthy).toBe(true);
  });

  test("renders a header, a rule and one row per check", () => {
    const report = new DoctorReport("1.0.0");
    report.fail(CHECK_CONFIGURATION, "no profile");
    const lines = report.render().split("\n");
    // header + rule + five checks
    expect(lines).toHaveLength(7);
    expect(lines[0]).toBe("name            status   message");
    expect(lines[1]).toMatch(/^-+ {2}-+ {2}-+$/);
    expect(lines[3]).toContain("configuration");
    expect(lines[3]).toContain("fail");
    expect(lines[3]).toContain("no profile");
  });

  test("uses a status word rather than a symbol, so it stays greppable", () => {
    const report = new DoctorReport("1.0.0");
    report.fail(CHECK_CONFIGURATION, "no profile");
    const rendered = report.render();
    expect(rendered).not.toContain("✔");
    expect(rendered).not.toContain("✖");
    expect(rendered).toContain("pass");
    expect(rendered).toContain("fail");
    expect(rendered).toContain("skipped");
  });

  test("toJSON returns copies, so a caller cannot mutate the report", () => {
    const report = new DoctorReport("1.0.0");
    const snapshot = report.toJSON();
    snapshot.checks[0].message = "tampered";
    expect(report.toJSON().checks[0].message).toBe("langfuse-cli 1.0.0");
  });
});
