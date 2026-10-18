import { SectionHeading } from "../../primitives/section-heading.tsx";

// A peer's read that failed, said here since the toast layer stays
// silent for a peer (gatedHostReadMeta). `heading` is the section's,
// for a section with nothing else to show.
export function PeerReadErrorView({
  what,
  device,
  message,
  heading,
}: {
  what: string;
  // The peer, by name.
  device: string;
  message: string;
  heading?: string;
}) {
  const note = (
    <p className="text-xs text-muted-foreground select-text">
      Couldn&apos;t check {what} on {device}: {message}
    </p>
  );
  if (heading === undefined) return note;
  return (
    <section className="space-y-3">
      <SectionHeading className="mb-1">{heading}</SectionHeading>
      {note}
    </section>
  );
}
