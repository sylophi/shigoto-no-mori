// One script on or off a launch row list, for the renderer's optimistic
// cache write. The stored write is the engine's (Scripts.setOnLaunchRow).
// Returns the same array when nothing changes.
export function withLaunchRowScript(
  launchRow: readonly string[],
  scriptName: string,
  onRow: boolean,
): readonly string[] {
  if (launchRow.includes(scriptName) === onRow) return launchRow;
  return onRow
    ? [...launchRow, scriptName]
    : launchRow.filter((name) => name !== scriptName);
}
