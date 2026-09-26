// One script on or off a launch row list, used by both the host (the
// stored write) and the renderer (the optimistic cache write), so the
// two agree. Returns the same array when nothing changes.
export function withLaunchRowScript(
  launchRow: string[],
  scriptName: string,
  onRow: boolean,
): string[] {
  if (launchRow.includes(scriptName) === onRow) return launchRow;
  return onRow
    ? [...launchRow, scriptName]
    : launchRow.filter((name) => name !== scriptName);
}
