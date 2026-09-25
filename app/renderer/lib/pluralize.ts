// "1 file" / "3 files". The plural is the singular plus "s" unless given.
export function pluralize(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
