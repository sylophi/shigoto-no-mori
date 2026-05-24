// emerald-500 / rose-500 read close to Pierre's dark/light addition
// and deletion hues without requiring shadow-DOM theme variables.
export function DiffStats({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  const label = `${additions} additions, ${deletions} deletions`;
  return (
    <span
      aria-label={label}
      title={label}
      className="tabular inline-flex shrink-0 items-center gap-1.5 font-mono text-xs"
    >
      <span className="text-emerald-500">+{additions}</span>
      <span className="text-rose-500">−{deletions}</span>
    </span>
  );
}
