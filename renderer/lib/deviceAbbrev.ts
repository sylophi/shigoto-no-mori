// "Studio Mac" -> SM, "Thinkpad" -> TH, "Work PC" -> WP. Word initials
// when there are two words, else the first two letters. Enough to tell
// an account's handful of machines apart, with the full name on hover.
// One rule for every mark that stands in for a device (the sidebar's
// badges, the devices page's avatar), so two surfaces can never
// abbreviate the same machine differently.
export function deviceAbbrev(label: string): string {
  const words = label.trim().split(/\s+/);
  const first = words[0] ?? "";
  const second = words[1];
  const abbrev =
    second !== undefined && second.length > 0
      ? `${first[0] ?? ""}${second[0] ?? ""}`
      : first.slice(0, 2);
  return abbrev.toUpperCase();
}
