import type { ReactNode } from "react";

// A list of rows boxed by a hairline, with a rule between each. In
// doubutsu, where no border draws, the frame is a see-through tray
// (data-slot="frame", doubutsu.css).
export function FramedList({ children }: { children: ReactNode }) {
  return (
    <div
      data-slot="frame"
      className="divide-y divide-border overflow-hidden rounded-md border border-border"
    >
      {children}
    </div>
  );
}
