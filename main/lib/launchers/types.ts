// Shared shapes for the per-platform launcher implementations. Each
// platform ships its own catalog (an app that doesn't exist on an OS is
// simply absent from that OS's list -- no Xcode entry on Windows), and
// exposes the same two-method surface so index.ts can pick one
// implementation and everything downstream stays platform-free.

export interface DetectedApp {
  id: string;
  label: string;
  // macOS .app bundle names; empty on Windows.
  bundleNames: string[];
  // Resolved Windows executable (first winPaths candidate that exists),
  // captured at detection time so launch uses exactly what detection
  // vouched for. `__explorer__` is the Explorer sentinel; null when only
  // a CLI shim was found (or on macOS).
  winExe: string | null;
  cli?: string | undefined;
  available: boolean;
}

export interface PlatformLaunchers {
  detect(): Promise<DetectedApp[]>;
  launch(app: DetectedApp, worktreePath: string): Promise<void>;
}
