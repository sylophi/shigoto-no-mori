export interface DetectedApp {
  id: string;
  label: string;
  // macOS .app bundle names. `__finder__` is the always-available
  // Finder sentinel.
  bundleNames: string[];
  cli?: string | undefined;
  available: boolean;
}
