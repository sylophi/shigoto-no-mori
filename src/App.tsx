import { TooltipProvider } from "@/components/ui/tooltip";
import { Shell } from "@/components/Shell";
import { CommandPalette } from "@/components/CommandPalette";
import { CommandPaletteProvider } from "@/hooks/useCommandPalette";
import { SelectionProvider } from "@/hooks/useSelection";
import { ThemeProvider } from "@/hooks/useTheme";

export function App() {
  return (
    <ThemeProvider>
      <SelectionProvider>
        <CommandPaletteProvider>
          <TooltipProvider>
            <Shell />
            <CommandPalette />
          </TooltipProvider>
        </CommandPaletteProvider>
      </SelectionProvider>
    </ThemeProvider>
  );
}
