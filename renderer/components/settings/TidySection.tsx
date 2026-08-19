import { useNavigate } from "@tanstack/react-router";
import { Trees } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionHeading } from "@/components/ui/section-heading";

// The way into the app-wide tidy page. It lives in settings rather than
// on a project menu because what it answers is a machine-level question
// -- what all of this is costing, across every project -- and because
// this is already the page that owns where the data lives (above) and
// how to delete all of it (below). Tidying is the surgical middle of
// those two.
export function TidySection() {
  const navigate = useNavigate();
  return (
    <section className="space-y-3">
      <SectionHeading className="mb-1">Tidy the forest</SectionHeading>
      <p className="text-xs text-muted-foreground">
        Review every worktree across all your projects: how much disk each one
        holds, how long since anything happened in it, and whether its work has
        already landed in the primary branch. Nothing is removed without
        confirming exactly what goes.
      </p>
      <Button
        variant="outline"
        size="sm"
        onClick={() => void navigate({ to: "/tidy" })}
      >
        <Trees />
        Tidy up worktrees…
      </Button>
    </section>
  );
}
