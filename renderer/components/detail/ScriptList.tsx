export function ScriptList({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-md border border-border">
      {children}
    </div>
  );
}
