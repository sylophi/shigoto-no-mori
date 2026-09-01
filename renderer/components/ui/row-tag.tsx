// Neutral marker for a property of the thing a row names ("External",
// "Shelved", "This device"): small caps in the muted family, so it
// reads as a label on the row rather than as a status the row is in.
export function RowTag({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
      {children}
    </span>
  );
}
