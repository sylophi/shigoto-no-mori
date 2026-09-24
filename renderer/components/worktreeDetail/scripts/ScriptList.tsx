// A grid of as many columns as the page width fits, filled row by row
// so a sorted list still reads from the top. Every cell draws its right
// and bottom rules, and the inner grid hangs a pixel past the frame's
// right and bottom edges, so the last column's and last row's rules
// hide under the frame's own border. The column floor is a spacing step
// (not a rem literal) so it grows with the phone layout's scale, and
// gives way to the frame's width when the frame is narrower still.
export function ScriptList({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div className="-mr-px -mb-px grid grid-cols-[repeat(auto-fill,minmax(min(--spacing(56),100%),1fr))] *:border-r *:border-b *:border-border">
        {children}
      </div>
    </div>
  );
}
