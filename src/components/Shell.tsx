import { Sidebar } from "./sidebar/Sidebar";
import { DetailPane } from "./detail/DetailPane";

export function Shell() {
  return (
    <div className="grid h-dvh grid-cols-[280px_1fr] overflow-hidden bg-background text-foreground">
      <Sidebar />
      <main className="relative flex h-full flex-col overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-auto absolute inset-x-0 top-0 z-30 h-7"
          style={{ ["-webkit-app-region" as never]: "drag" }}
        />
        <DetailPane />
      </main>
    </div>
  );
}
