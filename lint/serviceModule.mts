// A service module is a `.ts` or `.mts` file named for its service, in
// PascalCase: `Registry.ts`, `GitWatcher.mts` (EFFECT.md, section 2).
// Tests (`Registry.test.ts`), declarations and every lowercase module
// are not. README.md has the rules that apply to one.
const SERVICE_MODULE = /(?:^|[\\/])[A-Z][A-Za-z0-9]*\.m?ts$/;

export function isServiceModule(filename: string): boolean {
  return SERVICE_MODULE.test(filename);
}
