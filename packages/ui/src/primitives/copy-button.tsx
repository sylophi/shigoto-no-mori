import { useState } from "react";
import { Check, Copy } from "lucide-react";

interface CopyButtonProps {
  value: string;
  label?: string;
}

// Copies a value and says so for a moment: the check a copy control
// swaps its icon for.
export function useCopied(value: string): [copied: boolean, copy: () => void] {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return [copied, copy];
}

export function CopyButton({ value, label = "Copy" }: CopyButtonProps) {
  const [copied, copy] = useCopied(value);
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={label}
      data-icon-button
      // Always shown in the phone layout: nothing hovers on a touch
      // screen, so a control that waits for the cursor never appears.
      className="shrink-0 rounded-md p-1 text-muted-foreground/50 opacity-0 transition-opacity group-hover/copy:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 phone:opacity-100"
    >
      {copied ? (
        <Check className="size-3.5 text-foreground" />
      ) : (
        <Copy className="size-3.5" />
      )}
    </button>
  );
}
