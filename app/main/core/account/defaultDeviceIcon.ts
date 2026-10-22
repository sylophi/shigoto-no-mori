// What kind of Mac a desktop device is, as far as macOS will say, for
// the icon it enrolls under before anyone picks one. Pure node (a child
// process), electron-free like the rest of main/core/account/ so the
// account check script drives the mapping half. Every probe may fail,
// and a failure reads as the fallback shape rather than an error: the
// icon is cosmetic, and a status read must never break on it.
import {
  MACHINE_FALLBACK_ICON,
  type DeviceShape,
} from "@shigomori/contracts/deviceIcon";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// Apple's product name ("Mac mini (2024)", "MacBook Pro") or model
// identifier ("MacBookPro18,3", "Macmini9,1"), as ioreg and sysctl
// report them. The family prefix is what places the machine, and the
// rest never matters here. Apple silicon machines report a bare "Mac16,10"
// identifier, which says nothing about the shape, so the product name
// is asked for first and the identifier is the fallback for the
// machines that still spell a family into it.
export function deviceShapeFromAppleModel(model: string): DeviceShape | null {
  const normalized = model.replace(/[\s-]/g, "").toLowerCase();
  if (normalized.startsWith("macbook")) return "laptop";
  if (normalized.startsWith("macmini")) return "mini";
  if (normalized.startsWith("macstudio")) return "mini";
  if (normalized.startsWith("imac") || normalized.startsWith("macpro")) {
    return "desktop";
  }
  return null;
}

// The product name the "About this Mac" window shows, from the
// IORegistry's product node: `"product-name" = <"Mac mini (2024)">`.
export function appleProductNameOf(ioregOutput: string): string | null {
  const match = /"product-name"\s*=\s*<"([^"]*)">/.exec(ioregOutput);
  const name = match?.[1]?.trim() ?? "";
  return name === "" ? null : name;
}

async function run(file: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileP(file, args, { timeout: 2000 });
  return stdout;
}

async function macShape(): Promise<DeviceShape | null> {
  try {
    const name = appleProductNameOf(
      await run("/usr/sbin/ioreg", ["-rd1", "-n", "product"]),
    );
    const shape = name === null ? null : deviceShapeFromAppleModel(name);
    if (shape !== null) return shape;
  } catch {
    // Fall through to the identifier.
  }
  try {
    return deviceShapeFromAppleModel(
      (await run("/usr/sbin/sysctl", ["-n", "hw.model"])).trim(),
    );
  } catch {
    return null;
  }
}

// The icon this desktop device detects for itself. Never rejects:
// an unreadable probe lands on the fallback shape.
export async function detectDesktopDeviceShape(): Promise<DeviceShape> {
  return (await macShape()) ?? MACHINE_FALLBACK_ICON;
}
