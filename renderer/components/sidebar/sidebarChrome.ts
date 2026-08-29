// The sidebar's bare icon buttons, above the list and below it. Not the
// `ui/button.tsx` primitive on purpose: these are chrome sized to the
// sidebar's 12px rhythm rather than the app's button scale, and both
// ends have to match each other more than they have to match a dialog's
// buttons. One constant so they still do after the next tweak.
export const SIDEBAR_ICON_BUTTON =
  "rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground";

// The footer bar both shells hang their action cluster in, same
// one-constant reasoning as the icon buttons above.
export const SIDEBAR_FOOTER_BAR =
  "flex items-center gap-1 border-t border-border px-2 py-1.5";
