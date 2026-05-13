import { TooltipProvider } from "@/components/ui/tooltip";
import { Shell } from "@/components/Shell";
import { SelectionProvider } from "@/hooks/useSelection";
import { ThemeProvider } from "@/hooks/useTheme";

export function App() {
  return (
    <ThemeProvider>
      <SelectionProvider>
        <TooltipProvider>
          <Shell />
        </TooltipProvider>
      </SelectionProvider>
    </ThemeProvider>
  );
}
