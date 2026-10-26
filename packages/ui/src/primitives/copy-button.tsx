import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { IconButton } from "./icon-button.tsx";

interface CopyButtonProps {
  value: string;
  label?: string;
}

// Copies a value and says so for a moment: the check a copy control
// swaps its icon for. A function is read at the click.
export function useCopied(
  value: string | (() => string),
): [copied: boolean, copy: () => void] {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const text = typeof value === "string" ? value : value();
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return [copied, copy];
}

export function CopyButton({ value, label = "Copy" }: CopyButtonProps) {
  const [copied, copy] = useCopied(value);
  return (
    <IconButton
      onClick={copy}
      aria-label={label}
      reveal
      className="group-hover/copy:opacity-100"
    >
      {copied ? (
        <Check className="size-3.5 text-foreground" />
      ) : (
        <Copy className="size-3.5" />
      )}
    </IconButton>
  );
}
