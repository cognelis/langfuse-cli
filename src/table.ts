// Human-readable rendering for terminal output.
//
// The shapes here match signoz-cli so the two tools read the same way: a header
// row over a dashed rule, columns separated by two spaces and sized to their
// widest cell, and key/value blocks whose keys are padded to a common width.
//
// Only the human-facing path uses this. Machine-readable output is the JSON
// envelope, which is what a pipeline gets by default.

const COLUMN_GAP = "  ";

/** Terminal columns a string occupies: East Asian wide and fullwidth characters take two. */
function displayWidth(value: string): number {
  let width = 0;
  for (const char of value) width += isWide(char.codePointAt(0) ?? 0) ? 2 : 1;
  return width;
}

// ponytail: the common East Asian wide ranges only; combining marks and joined
// emoji still count per code point. Use a full Unicode width table if they misalign.
function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/** Pads with spaces to `width` terminal columns. */
function padDisplay(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - displayWidth(value)));
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
      .map((cell, index) => padDisplay(cell, widths[index] ?? 0))
      .join(COLUMN_GAP)
      .replace(/\s+$/, "");
  const rule = widths.map((width) => "-".repeat(width));
  return [line(headers), line(rule), ...rows.map(line)].join("\n");
}

/** Renders `key: value` pairs with the keys padded to a common width. */
export function renderKeyValues(pairs: Array<[string, string]>): string {
  const width = Math.max(0, ...pairs.map(([key]) => displayWidth(key)));
  return pairs
    .map(([key, value]) => `${padDisplay(key, width)}: ${value}`)
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
