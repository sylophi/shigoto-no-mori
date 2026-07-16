// Pluralized commit-count fragment for sync pill labels.
export function commitsLabel(n: number): string {
  return n === 1 ? "1 commit" : `${n} commits`;
}
