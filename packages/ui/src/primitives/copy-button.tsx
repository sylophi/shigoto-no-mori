import { type ComponentProps, useState } from "react";
import { Check, Copy } from "lucide-react";
import { IconButton } from "./icon-button.tsx";
import { cn } from "../lib/utils.ts";

interface CopyButtonProps {
  value: string;
  label?: string;
  size?: ComponentProps<typeof IconButton>["size"];
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

export function CopyButton({ value, label = "Copy", size }: CopyButtonProps) {
  const [copied, copy] = useCopied(value);
  const icon = size === "xs" ? "size-3" : "size-3.5";
  return (
    <IconButton
      onClick={copy}
      aria-label={label}
      size={size}
      reveal
      className="group-hover/copy:opacity-100"
    >
      {copied ? (
        <Check className={cn(icon, "text-foreground")} />
      ) : (
        <Copy className={icon} />
      )}
    </IconButton>
  );
}
