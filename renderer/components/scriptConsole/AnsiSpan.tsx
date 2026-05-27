import { type AnserJsonEntry } from "anser";
import { cn } from "@/lib/utils";
import { resolveAnsiInline } from "./scriptConsoleAnsi";

export function AnsiSpan({ token }: { token: AnserJsonEntry }) {
  const decorations = token.decorations ?? [];
  const style: React.CSSProperties = {};
  // Anser's JSON emits raw color names in `fg` / `bg`:
  //   - "ansi-red"..."ansi-bright-white" for the 16 base colors;
  //     we need to append "-fg" / "-bg" to hit our CSS classes.
  //   - "ansi-palette-N" for 256-color indices 16-255;
  //     we resolve those to rgb() via the standard xterm palette.
  //   - "ansi-truecolor" for 24-bit; the rgb string is in
  //     fg_truecolor / bg_truecolor.
  let fgClass: string | null = null;
  let bgClass: string | null = null;
  if (token.fg) {
    const inline = resolveAnsiInline(token.fg, token.fg_truecolor);
    if (inline) style.color = inline;
    else fgClass = `${token.fg}-fg`;
  }
  if (token.bg) {
    const inline = resolveAnsiInline(token.bg, token.bg_truecolor);
    if (inline) style.backgroundColor = inline;
    else bgClass = `${token.bg}-bg`;
  }
  const className = cn(
    fgClass,
    bgClass,
    decorations.includes("bold") && "font-semibold",
    decorations.includes("italic") && "italic",
    decorations.includes("underline") && "underline",
    decorations.includes("strikethrough") && "line-through",
    decorations.includes("dim") && "opacity-60",
    decorations.includes("hidden") && "invisible",
  );
  const hasStyle =
    style.color !== undefined || style.backgroundColor !== undefined;
  if (!className && !hasStyle) return token.content;
  return (
    <span className={className} style={hasStyle ? style : undefined}>
      {token.content}
    </span>
  );
}
