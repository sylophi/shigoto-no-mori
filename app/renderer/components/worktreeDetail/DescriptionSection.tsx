// The work's description (DescriptionSectionView), measured whether a
// long one is cut down.
import { useState } from "react";
import { useIsTruncated } from "@shigomori/ui/hooks/useIsTruncated.ts";
import { DescriptionSectionView } from "./DescriptionSectionView";

export function DescriptionSection({ description }: { description: string }) {
  const [expanded, setExpanded] = useState(false);
  const [ref, truncated] = useIsTruncated<HTMLDivElement>(description);
  return (
    <DescriptionSectionView
      description={description}
      expanded={expanded}
      onToggle={() => setExpanded((open) => !open)}
      truncated={truncated}
      bodyRef={ref}
    />
  );
}
