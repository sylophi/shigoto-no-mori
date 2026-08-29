// The settings scroll region and its column, shared by the local body
// and every peer body so the two read identically no matter which
// device the switcher names.
export function SettingsPane({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="flex max-w-3xl flex-col gap-10">{children}</div>
    </div>
  );
}
