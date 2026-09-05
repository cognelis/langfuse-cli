import { describe, expect, test } from "bun:test";

import { renderKeyValues, renderTable } from "./table";

describe("renderTable", () => {
  test("sizes each column to its widest cell", () => {
    const rendered = renderTable(
      ["current", "name", "host"],
      [
        ["*", "test", "https://a.example.com"],
        ["", "production", "https://b.example.com"],
      ],
    );
    const [header, rule, first, second] = rendered.split("\n");
    // "production" is wider than the "name" header, so the column follows it.
    expect(header).toBe("current  name        host");
    expect(rule).toBe("-------  ----------  ---------------------");
    expect(first).toBe("*        test        https://a.example.com");
    expect(second).toBe("         production  https://b.example.com");
  });

  test("the rule matches the header widths exactly", () => {
    const [header, rule] = renderTable(["a", "bbb"], [["x", "y"]]).split("\n");
    expect(rule.length).toBe(header.length);
    expect(rule).toMatch(/^-+ {2}-+$/);
  });

  test("does not leave trailing whitespace on short rows", () => {
    const rendered = renderTable(["name", "note"], [["x", ""]]);
    for (const line of rendered.split("\n")) {
      expect(line).toBe(line.replace(/\s+$/, ""));
    }
  });

  test("renders a header and rule even with no rows", () => {
    expect(renderTable(["name"], []).split("\n")).toEqual(["name", "----"]);
  });
});

describe("renderKeyValues", () => {
  test("pads keys to a common width so the colons line up", () => {
    expect(
      renderKeyValues([
        ["name", "test"],
        ["public key", "pk-lf-1"],
      ]),
    ).toBe("name      : test\npublic key: pk-lf-1");
  });

  test("handles a single pair without padding drift", () => {
    expect(renderKeyValues([["host", "https://a.example.com"]])).toBe(
      "host: https://a.example.com",
    );
  });

  test("keeps an empty value on the line", () => {
    expect(renderKeyValues([["note", ""]])).toBe("note: ");
  });
});
