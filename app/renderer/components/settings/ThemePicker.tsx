import { Check } from "lucide-react";
import {
  type DarkTheme,
  type LightTheme,
  optionHolds,
  type ThemeOption,
} from "@shared/themes";
import { usePalette } from "@/hooks/ui/usePalette";
import { cn } from "@/lib/utils";

// One row of the doubutsu palettes for an appearance: a swatch per
// palette with its name, the chosen one wearing a check in its
// accent. Pressed buttons in a group, the segmented control's
// vocabulary, since every swatch is its own tab stop. Two of
// these stack under the Doubutsu theme switch in Appearance, the light
// list and the dark list, so either can be picked whatever the window
// shows right now. Disabled with the switch off: the picks keep, and
// come back with it.
//
// A swatch paints itself with the palette's own tokens through the
// data-theme-scope hook (DESIGN.md, "Theming"), so the tile is the
// real palette and never a copy of its colors kept here. A swatch with
// hidden variants stands for all of them: it wears the staged one, or
// else the saved one, and a click on it picks what it wears, so a
// variant survives a round trip through another swatch.
export function ThemePicker<Id extends LightTheme | DarkTheme>({
  appearance,
  options,
  value,
  onChange,
  disabled = false,
}: {
  appearance: "light" | "dark";
  options: readonly ThemeOption<Id>[];
  value: Id;
  onChange: (next: Id) => void;
  disabled?: boolean;
}) {
  // The appearance's saved pick, for a swatch whose variant isn't staged.
  const saved = usePalette().saved[appearance] as Id;
  return (
    <div
      role="group"
      aria-label={appearance === "dark" ? "Dark palette" : "Light palette"}
      className={cn("flex flex-wrap gap-2", disabled && "opacity-50")}
    >
      {options.map((option) => {
        const selected = optionHolds(option, value);
        const shown = selected
          ? value
          : optionHolds(option, saved)
            ? saved
            : option.id;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => {
              if (!selected) onChange(shown);
            }}
            data-slot="theme-swatch"
            className={cn(
              "group flex w-20 flex-col items-center gap-1.5 rounded-lg p-1.5 transition-colors",
              selected ? "bg-accent" : "hover:bg-accent/50",
            )}
          >
            <ThemeSwatch appearance={appearance} id={shown} />
            <span
              className={cn(
                "text-2xs leading-none",
                selected
                  ? "font-semibold text-accent-foreground"
                  : "text-muted-foreground group-hover:text-foreground",
              )}
            >
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// The tile: the palette's rail beside its canvas, with a card, the
// accent pillow and the primary action on it, at postage-stamp size.
function ThemeSwatch({
  appearance,
  id,
}: {
  appearance: "light" | "dark";
  id: string;
}) {
  return (
    <span
      data-theme-scope
      data-palette={id}
      className={cn(
        "doubutsu",
        appearance === "dark" && "dark",
        "relative flex h-11 w-full overflow-hidden rounded-md bg-background text-foreground ring-1 ring-foreground/10",
      )}
    >
      <span className="h-full w-1/3 bg-[var(--doubutsu-sidebar)]" />
      <span className="flex flex-1 flex-col gap-1 p-1.5">
        <span className="h-1.5 w-3/4 rounded-full bg-card ring-1 ring-foreground/10" />
        <span className="h-1.5 w-1/2 rounded-full bg-accent" />
        <span className="mt-auto flex justify-end">
          <span className="size-2.5 rounded-full bg-primary" />
        </span>
      </span>
      <ThemeCheck />
    </span>
  );
}

// The chosen mark, drawn by the button's aria-pressed so the tile itself
// stays a plain paint of the palette.
function ThemeCheck() {
  return (
    <span
      aria-hidden
      className="absolute top-1 left-1 hidden size-3.5 items-center justify-center rounded-full bg-primary text-primary-foreground group-aria-pressed:flex"
    >
      <Check className="size-2.5" strokeWidth={3} />
    </span>
  );
}
