// Dashed placeholder panel for a body that has nothing to show yet: a
// peer's settings before its link is up.
export function EmptyPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
