import { SectionHeading } from "@/components/ui/section-heading";
import { ToggleRow } from "@/components/shared/ToggleRow";

// How the sidebar dresses its rows, in Appearance: a setting of this
// window, saved with the rest of the local form.
export function SidebarSection({
  markTerrierProjects,
  onMarkTerrierProjectsChange,
}: {
  markTerrierProjects: boolean;
  onMarkTerrierProjectsChange: (next: boolean) => void;
}) {
  return (
    <section className="space-y-3">
      <SectionHeading className="mb-1">Sidebar</SectionHeading>
      <ToggleRow
        checked={markTerrierProjects}
        onCheckedChange={onMarkTerrierProjectsChange}
        label="Mark terrier projects"
        description="Shows a paw beside the projects that come from the terrier registry, so they stand apart from the ones added here."
      />
    </section>
  );
}
