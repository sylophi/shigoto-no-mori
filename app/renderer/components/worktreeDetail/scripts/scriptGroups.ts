import type { PackageScriptsResult } from "@shared/schemas";

export type ScriptGroup = NonNullable<PackageScriptsResult["groups"]>[number];

// The files with scripts in them, each a group of its own in the
// Scripts section. A host on an older build lists package.json alone
// and sends no groups.
export function scriptGroups(pkg: PackageScriptsResult): ScriptGroup[] {
  const groups = pkg.groups ?? [
    {
      file: "package.json",
      labels: Object.fromEntries(
        Object.keys(pkg.scripts).map((name) => [name, name]),
      ),
    },
  ];
  return groups.filter((group) => Object.keys(group.labels).length > 0);
}
