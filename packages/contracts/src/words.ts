// The words a count or a list is said in, for every side that writes
// to a person: the views, the host's refusals, the engine's doctor.

// The word for a count: "file" for one, "files" for any other. The
// plural is the singular plus "s" unless given ("is", "are").
export function plural(
  count: number,
  singular: string,
  many = `${singular}s`,
): string {
  return count === 1 ? singular : many;
}

// The count and its word: "1 file", "3 files".
export function pluralize(
  count: number,
  singular: string,
  many = `${singular}s`,
): string {
  return `${count} ${plural(count, singular, many)}`;
}

// "a", "a and b", "a, b and c".
export function listed(parts: readonly string[]): string {
  if (parts.length < 2) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1) ?? ""}`;
}

// A sentence's first word as it starts one: "the other device" leads
// "The other device is offline".
export function capitalized(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1);
}
