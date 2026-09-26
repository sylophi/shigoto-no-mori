import { useEffect, useState } from "react";
import { faceColor } from "@/lib/villagers/faceColor";

// A character's own color, read off their face (lib/villagers/
// faceColor.ts), or null until it is, or without a clear one.
export function useFaceColor(face: string | null): string | null {
  const [color, setColor] = useState<{ face: string; color: string | null }>();
  useEffect(() => {
    if (face === null) return;
    let live = true;
    void faceColor(face).then((read) => {
      if (live) setColor({ face, color: read });
    });
    return () => {
      live = false;
    };
  }, [face]);
  return color !== undefined && color.face === face ? color.color : null;
}
