// What kind of device a browser client is, for the icon it enrolls
// under before anyone picks one: the web analogue of the desktop's
// machine probe (main/core/account/defaultDeviceIcon.ts), read off the
// same user agent the default name is. As coarse as that name, on
// purpose: a phone, a tablet, or a browser on something bigger is all
// the device list needs to tell apart, and the owner can pick another
// icon afterwards.
import type { DeviceShape } from "@shared/account/deviceIcon";

export function defaultWebDeviceShape(userAgent: string): DeviceShape {
  if (/iPad/.test(userAgent)) return "tablet";
  if (/iPhone/.test(userAgent)) return "phone";
  // Android phones carry "Mobile" in the UA and tablets leave it out.
  if (/Android/.test(userAgent)) {
    return /Mobile/.test(userAgent) ? "phone" : "tablet";
  }
  return "browser";
}
