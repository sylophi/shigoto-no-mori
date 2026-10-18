import {
  type ChangeEvent,
  type ComponentProps,
  useLayoutEffect,
  useRef,
} from "react";
import { cn } from "../lib/utils.ts";
import type { WithoutTitle } from "./tooltip.tsx";

// Single source of truth for text-field chrome. Sizing, font, and layout
// stay at the call site; this carries the surface + focus treatment so
// every field reads the same and theme overlays (doubutsu) have one
// stable data-slot hook instead of a per-site class contract.
export const fieldClass =
  "rounded-md border border-input bg-background transition-colors outline-none hover:border-ring/50 focus:border-ring focus:ring-2 focus:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50";

export function Input({
  className,
  selectOutsideChanges = false,
  onChange,
  ref,
  ...props
}: WithoutTitle<ComponentProps<"input">> & {
  // For a field whose value can arrive while the person is in it (an
  // async default): a value that changed from outside, under focus, is
  // selected, so what they type next replaces it rather than joining it.
  readonly selectOutsideChanges?: boolean;
}) {
  const field = useRef<HTMLInputElement>(null);
  const shown = useRef(props.value);
  const typed = useRef(false);
  useLayoutEffect(() => {
    const outside = !typed.current && shown.current !== props.value;
    typed.current = false;
    shown.current = props.value;
    const input = field.current;
    if (
      selectOutsideChanges &&
      outside &&
      input !== null &&
      input === input.ownerDocument.activeElement
    ) {
      input.select();
    }
  }, [props.value, selectOutsideChanges]);
  // An edit the parent refused leaves the value, and so the effect above,
  // as they were: the next render still starts unmarked.
  useLayoutEffect(() => {
    typed.current = false;
  });
  const attach = (node: HTMLInputElement | null) => {
    field.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  };
  return (
    <input
      data-slot="input"
      className={cn(fieldClass, className)}
      {...props}
      ref={attach}
      onChange={(event: ChangeEvent<HTMLInputElement>) => {
        typed.current = true;
        onChange?.(event);
      }}
    />
  );
}
