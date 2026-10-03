import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { fieldClass } from "./input";
import type { WithoutTitle } from "./tooltip";

export function Textarea({
  className,
  ...props
}: WithoutTitle<ComponentProps<"textarea">>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(fieldClass, className)}
      {...props}
    />
  );
}
