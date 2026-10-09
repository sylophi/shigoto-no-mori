// The update toast's link to what the update brings (UpdateReadyToast),
// under its title.
export function WhatsNewLinkView({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      data-no-hit-area
      onClick={onOpen}
      className="underline underline-offset-2 hover:text-foreground"
    >
      What&apos;s new
    </button>
  );
}
