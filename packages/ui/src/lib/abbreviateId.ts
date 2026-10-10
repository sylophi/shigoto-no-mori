// Shorten a long account id for display while keeping enough on each
// end to recognise it. Short ids and the empty signed-out case pass
// through. One rule for every page that prints an id, so two surfaces
// can't abbreviate the same id differently.
export function abbreviateId(id: string): string {
  if (id === "") return "(no id)";
  if (id.length <= 16) return id;
  return `${id.slice(0, 10)}…${id.slice(-4)}`;
}
