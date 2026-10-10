// Formats a byte count for inline display ("48 B", "9.4 MB", "1.2 GB").
// Base 1024 with short unit names, matching what `du -h` prints and what
// a developer looking at a node_modules figure expects.
//
// One decimal below 10 in each unit, none above, so a column of sizes
// stays about the same width without a monospace font.
const UNITS = ["KB", "MB", "GB", "TB"] as const;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${UNITS[unit]}`;
}
