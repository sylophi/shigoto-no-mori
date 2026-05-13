import { Sidebar } from "./sidebar/Sidebar";
import { DetailPane } from "./detail/DetailPane";

export function Shell() {
  return (
    <div className="grid h-dvh grid-cols-[280px_1fr] overflow-hidden bg-background text-foreground">
      <Sidebar />
      <main className="flex h-full flex-col overflow-hidden">
        <DetailPane />
      </main>
    </div>
  );
}
