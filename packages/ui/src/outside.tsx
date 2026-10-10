// How a view reaches outside the app: a web URL opens in the system
// browser, a local path in the file manager. The app provides both at
// its root (they go through the host, and report a failure as a toast);
// a scene gets the defaults, which do nothing. A view takes them at
// render and calls them at click time.
import { createContext, useContext } from "react";

export type Outside = {
  readonly openUrl: (url: string, errorTitle?: string) => void;
  readonly revealInFolder: (path: string, errorTitle: string) => void;
};

const OutsideContext = createContext<Outside>({
  openUrl: () => {},
  revealInFolder: () => {},
});

export const OutsideProvider = OutsideContext.Provider;

export function useOutside(): Outside {
  return useContext(OutsideContext);
}
