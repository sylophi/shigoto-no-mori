// The one sentence every surface uses for a peer that will not run
// commands from here: the switch lives on the other machine's Devices
// page, so the sentence always points there. Nine surfaces say it
// (notes, footers, forwards, the device picker, the registry row), so
// it is written once. `deviceLabel` is how the caller names the
// machine in its own sentence: "Thinkpad", "it", "this device".
export function peerReadOnlyNote(deviceLabel = "that device"): string {
  return `Read-only until ${deviceLabel} allows control from other devices on its Devices page.`;
}
