// Dashed placeholder panel shared by the remote forest and the remote
// device settings pane.
export function EmptyPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
