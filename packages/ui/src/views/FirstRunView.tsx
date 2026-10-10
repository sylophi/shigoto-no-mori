// The home with no project to show (every one removed since the first
// run): the way to the next.
import { Button } from "../primitives/button.tsx";

export function FirstRunView({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <Button size="sm" onClick={onAdd}>
        Add a project
      </Button>
    </div>
  );
}
