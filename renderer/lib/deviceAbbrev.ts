// "Studio Mac" -> SM, "Thinkpad" -> TH, "Work PC" -> WP. Word initials
// when there are two words, else the first two letters. Enough to tell
// an account's handful of machines apart, with the full name on hover.
// One rule for every mark that stands in for a device (the sidebar's
// badges, the devices page's avatar), so two surfaces can never
// abbreviate the same machine differently. Only letters and digits
// count, so "Mac (work)" reads MW rather than "M(".
export function deviceAbbrev(label: string): string {
  const words = label
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((word) => word.length > 0);
  // A label with no letters or digits at all (an emoji, a dash) keeps
  // its first two characters rather than vanishing.
  if (words.length === 0) return label.trim().slice(0, 2).toUpperCase();
  const first = words[0]!;
  const second = words[1];
  const abbrev =
    second !== undefined
      ? `${first[0] ?? ""}${second[0] ?? ""}`
      : first.slice(0, 2);
  return abbrev.toUpperCase();
}
