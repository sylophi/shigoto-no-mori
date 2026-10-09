// Decodes a node ws inbound payload to UTF-8 text, for the hub
// connection. Under host/ because RawData and Buffer are node facts the
// browser-consumed protocol layer must not import.
import type { RawData } from "ws";

export function toText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}
