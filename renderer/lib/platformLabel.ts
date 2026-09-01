// Node's process.platform spelling, as the word a person would use for
// the machine. Unknown values pass through: an honest raw string beats
// a wrong label.
const PLATFORM_LABEL: Record<string, string> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
};

export function platformLabel(platform: string): string {
  return PLATFORM_LABEL[platform] ?? platform;
}
