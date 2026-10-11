import type { PackageScriptsResult } from "@shared/schemas";

export type ScriptGroup = NonNullable<PackageScriptsResult["groups"]>[number];

// The files with scripts in them, each a group of its own in the
// Scripts section. A host on an older build lists package.json alone
// and sends no groups.
export function scriptGroups(pkg: PackageScriptsResult): ScriptGroup[] {
  return (
    pkg.groups ?? [
      {
        file: "package.json",
        labels: Object.fromEntries(
          Object.keys(pkg.scripts).map((name) => [name, name]),
        ),
      },
    ]
  );
}

// The name a script goes by in its file's group ("build" for "just
// build").
export function labelOf(group: ScriptGroup, name: string): string {
  return group.labels[name] ?? name;
}
