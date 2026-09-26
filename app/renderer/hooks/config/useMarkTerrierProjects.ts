import { useQuery } from "@tanstack/react-query";
import { clientConfigQueryOptions } from "./useClientConfig";

// Whether this window marks terrier-sourced projects in the sidebar.
// Client-scoped like the theme, so it holds for every device's projects
// the window shows. False until the config has loaded, so a paw never
// flashes in while it is off. Selected down to the one flag: every
// sidebar row reads it, and folding a project writes the same doc.
export function useMarkTerrierProjects(): boolean {
  const { data } = useQuery({
    ...clientConfigQueryOptions,
    select: (config) => config.markTerrierProjects === true,
    meta: { errorTitle: "Couldn't load appearance settings" },
  });
  return data === true;
}
