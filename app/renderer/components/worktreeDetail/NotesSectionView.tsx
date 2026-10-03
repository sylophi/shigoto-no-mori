// The Notes section as drawn (NotesSection.tsx loads and saves them):
// the heading with the save status, over the notes.
import { SectionHeading } from "@/components/ui/section-heading";
import { Textarea } from "@/components/ui/textarea";
import { peerReadOnlyNote } from "@/lib/commandAccessCopy";

export function NotesSectionView({
  notes,
  status = "",
  readOnly = false,
  onChange,
  onBlur,
}: {
  notes: string;
  // "Saving…", "Saved", or nothing.
  status?: string;
  // A remote host that hasn't granted command access would refuse the
  // write, so the editor says so up front.
  readOnly?: boolean;
  onChange?: (notes: string) => void;
  onBlur?: () => void;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <SectionHeading>Notes</SectionHeading>
        <span className="text-xs text-muted-foreground/60">{status}</span>
      </div>
      <Textarea
        value={notes}
        onChange={(e) => onChange?.(e.target.value)}
        onBlur={onBlur}
        rows={3}
        readOnly={readOnly}
        title={readOnly ? peerReadOnlyNote() : undefined}
        className="w-full resize-y px-3 py-2 text-sm read-only:opacity-60"
      />
    </section>
  );
}
