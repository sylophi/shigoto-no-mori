export function ScriptList({ children }: { children: React.ReactNode }) {
  return (
    <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
      {children}
    </div>
  );
}
