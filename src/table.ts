// Human-readable rendering for terminal output.
//
// The shapes here match signoz-cli so the two tools read the same way: a header
// row over a dashed rule, columns separated by two spaces and sized to their
// widest cell, and key/value blocks whose keys are padded to a common width.
//
// Only the human-facing path uses this. Machine-readable output is the JSON
// envelope, which is what a pipeline gets by default.

const COLUMN_GAP = "  ";

function displayWidth(value: string): number {
  return value.length;
}

/**
 * Renders a header, a dashed rule and the rows, each column padded to its
 * widest cell. Trailing padding is trimmed so lines do not carry stray spaces.
 */
export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(
      displayWidth(header),
      ...rows.map((row) => displayWidth(row[index] ?? "")),
    ),
  );
  const line = (cells: string[]): string =>
    cells
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join(COLUMN_GAP)
      .replace(/\s+$/, "");
  const rule = widths.map((width) => "-".repeat(width));
  return [line(headers), line(rule), ...rows.map(line)].join("\n");
}

/** Renders `key: value` pairs with the keys padded to a common width. */
export function renderKeyValues(pairs: Array<[string, string]>): string {
  const width = Math.max(0, ...pairs.map(([key]) => displayWidth(key)));
  return pairs
    .map(([key, value]) => `${key.padEnd(width)}: ${value}`)
    .join("\n");
}

/**
 * Writes the trailing context line to stderr.
 *
 * It belongs on stderr because it is commentary about the result, not the
 * result: stdout has to stay clean even when a human-readable table is being
 * piped somewhere.
 */
export function writeContext(profile?: string): void {
  if (profile) process.stderr.write(`Profile: ${profile}\n`);
}
