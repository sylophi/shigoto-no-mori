// Decodes a node ws inbound payload to UTF-8 text, shared by the LAN
// listener and the hub connection. Lives under host/ rather than the
// shared frame modules because RawData and Buffer are node facts the
// browser-consumed protocol layer must not import.
import type { RawData } from "ws";

export function toText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

// The inbound payload as one contiguous byte view, for binary (channel)
// frames. ws hands a Buffer, a Buffer list or an ArrayBuffer depending
// on fragmentation and options.
export function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}
