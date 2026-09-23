// What kind of machine a desktop device is, as far as the OS will say,
// for the icon it enrolls under before anyone picks one. Pure node (os
// and a child process, a few sysfs reads), electron-free like the rest
// of main/core/account/ so the account check script drives the
// mapping half. Every probe may fail, and a failure reads as the
// platform fallback rather than an error: the kind is cosmetic, and a
// status read must never break on it.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { platform } from "node:os";
import { promisify } from "node:util";
import {
  fallbackDeviceKind,
  type DeviceShape,
} from "@shared/account/deviceKind";

const execFileP = promisify(execFile);

// Apple's product name ("Mac mini (2024)", "MacBook Pro") or model
// identifier ("MacBookPro18,3", "Macmini9,1"), as ioreg and sysctl
// report them. The family prefix is what places the machine; the rest
// never matters here. Apple silicon machines report a bare "Mac16,10"
// identifier, which says nothing about the shape, so the product name
// is asked for first and the identifier is the fallback for the
// machines that still spell a family into it.
export function deviceKindFromAppleModel(model: string): DeviceShape | null {
  const normalized = model.replace(/[\s-]/g, "").toLowerCase();
  if (normalized.startsWith("macbook")) return "laptop";
  if (normalized.startsWith("macmini")) return "mini";
  if (normalized.startsWith("macstudio")) return "mini";
  if (normalized.startsWith("imac") || normalized.startsWith("macpro")) {
    return "desktop";
  }
  return null;
}

// SMBIOS chassis types (System Management BIOS spec, table 17), as
// /sys/class/dmi/id/chassis_type reports them. Only the codes that say
// a shape are listed; the rest ("Other", "Unknown", docking stations)
// fall through.
const DMI_CHASSIS_KIND: Record<string, DeviceShape> = {
  "3": "desktop", // Desktop
  "4": "desktop", // Low profile desktop
  "5": "desktop", // Pizza box
  "6": "desktop", // Mini tower
  "7": "desktop", // Tower
  "8": "laptop", // Portable
  "9": "laptop", // Laptop
  "10": "laptop", // Notebook
  "11": "tablet", // Hand held
  "13": "desktop", // All in one
  "14": "laptop", // Sub notebook
  "15": "mini", // Space-saving
  "16": "mini", // Lunch box
  "17": "server", // Main server chassis
  "22": "server", // Expansion chassis
  "23": "server", // Rack mount chassis
  "24": "server", // Sealed-case PC
  "25": "server", // Multi-system chassis
  "30": "tablet", // Tablet
  "31": "laptop", // Convertible
  "32": "laptop", // Detachable
  "34": "mini", // Embedded PC
  "35": "mini", // Mini PC
  "36": "mini", // Stick PC
};

// Vendor and product strings a hypervisor or a cloud host writes into
// the DMI tables. A virtual machine has no shape of its own: it is a
// box somewhere, which is what "server" says.
const VIRTUAL_MARKERS = [
  "qemu",
  "kvm",
  "vmware",
  "virtualbox",
  "xen",
  "hyper-v",
  "parallels",
  "amazon ec2",
  "google compute engine",
  "digitalocean",
  "hetzner",
  "linode",
  "openstack",
  "virtual machine",
];

export function deviceKindFromDmi(dmi: {
  chassisType: string | null;
  vendor: string | null;
  product: string | null;
}): DeviceShape | null {
  const vendorProduct =
    `${dmi.vendor ?? ""} ${dmi.product ?? ""}`.toLowerCase();
  if (VIRTUAL_MARKERS.some((marker) => vendorProduct.includes(marker))) {
    return "server";
  }
  // A Mac running Linux (Asahi) still reports its Apple product name.
  const apple =
    dmi.product === null ? null : deviceKindFromAppleModel(dmi.product);
  if (apple !== null) return apple;
  const code = dmi.chassisType?.trim() ?? "";
  return DMI_CHASSIS_KIND[code] ?? null;
}

async function readTrimmed(path: string): Promise<string | null> {
  try {
    const text = (await readFile(path, "utf8")).trim();
    return text === "" ? null : text;
  } catch {
    return null;
  }
}

// The product name the "About this Mac" window shows, from the
// IORegistry's product node: `"product-name" = <"Mac mini (2024)">`.
export function appleProductNameOf(ioregOutput: string): string | null {
  const match = /"product-name"\s*=\s*<"([^"]*)">/.exec(ioregOutput);
  const name = match?.[1]?.trim() ?? "";
  return name === "" ? null : name;
}

async function run(file: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileP(file, [...args], {
    encoding: "utf8",
    timeout: 2000,
  });
  return stdout;
}

async function macKind(): Promise<DeviceShape | null> {
  try {
    const name = appleProductNameOf(
      await run("/usr/sbin/ioreg", ["-rd1", "-n", "product"]),
    );
    const kind = name === null ? null : deviceKindFromAppleModel(name);
    if (kind !== null) return kind;
  } catch {
    // Fall through to the identifier.
  }
  try {
    return deviceKindFromAppleModel(
      (await run("/usr/sbin/sysctl", ["-n", "hw.model"])).trim(),
    );
  } catch {
    return null;
  }
}

async function linuxKind(): Promise<DeviceShape | null> {
  // WSL has no chassis, and a Windows machine's shape is unknown from
  // inside it: leave it to the fallback.
  const release = await readTrimmed("/proc/sys/kernel/osrelease");
  if (release?.toLowerCase().includes("microsoft")) return null;
  const [chassisType, vendor, product] = await Promise.all([
    readTrimmed("/sys/class/dmi/id/chassis_type"),
    readTrimmed("/sys/class/dmi/id/sys_vendor"),
    readTrimmed("/sys/class/dmi/id/product_name"),
  ]);
  return deviceKindFromDmi({ chassisType, vendor, product });
}

// The kind this desktop device detects itself to be. Never rejects:
// an unreadable probe lands on the platform fallback.
export async function detectDesktopDeviceKind(): Promise<DeviceShape> {
  const fallback = fallbackDeviceKind(platform());
  try {
    switch (platform()) {
      case "darwin":
        return (await macKind()) ?? fallback;
      case "linux":
        return (await linuxKind()) ?? fallback;
      default:
        return fallback;
    }
  } catch {
    return fallback;
  }
}
