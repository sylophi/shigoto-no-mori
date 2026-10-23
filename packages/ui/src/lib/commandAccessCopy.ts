// The one sentence every surface uses for a peer that will not run
// commands from here: the switch lives on the other machine's account
// page, so the sentence names that machine and the switch by its label.
// `deviceLabel` is how the caller names the machine in its own
// sentence: "Thinkpad", "it", "this device".
export function peerReadOnlyNote(deviceLabel: string): string {
  return `Read-only until ${allowsControl(deviceLabel)}.`;
}

// The same sentence where "read-only" would be no news: a peer's files
// are only browsed, a script's output only followed, and a terminal
// only shown, on its grant.
export function peerFilesHiddenNote(deviceLabel: string): string {
  return `Files stay hidden until ${allowsControl(deviceLabel)}.`;
}

export function peerOutputHiddenNote(deviceLabel: string): string {
  return `Output stays hidden until ${allowsControl(deviceLabel)}.`;
}

export function peerTerminalsHiddenNote(deviceLabel: string): string {
  return `Terminals stay hidden until ${allowsControl(deviceLabel)}.`;
}

// A mirror's, while the device holding its copy turns it away: the line
// beside its "Paused", by the switch that is off there.
export function mirrorPausedUntil(
  deviceLabel: string,
  off: CopySwitchOff,
): string {
  return `until ${off === "control" ? allowsControl(deviceLabel) : sharesData(deviceLabel)}`;
}

export type CopySwitchOff = "control" | "sharing";

type Switches = {
  readonly acceptsCommands?: boolean;
  readonly sharing?: boolean;
};

// The switch that is off on the device holding a mirror's copy, which
// turns the mirror away until it is on: this device's own, as its
// settings read, when the copy is here, or a peer's as this device's
// link reports it (a peer not sharing lists as such). Sharing first, as
// "Mirror here" names them. A switch not read yet counts as on.
export function copySwitchOff(copy: {
  readonly here: boolean;
  readonly own: Switches;
  readonly peer: Switches;
}): CopySwitchOff | undefined {
  const switches = copy.here ? copy.own : copy.peer;
  if (switches.sharing === false) return "sharing";
  return switches.acceptsCommands === false ? "control" : undefined;
}

function allowsControl(deviceLabel: string): string {
  return `${deviceLabel} turns on “Allow control from other devices” on its account page`;
}

function sharesData(deviceLabel: string): string {
  return `${deviceLabel} turns on “Share with other devices” on its account page`;
}

// Whether THIS device may command a device: the other machine's own
// "allow control from other devices" switch, as its connectInfo answer
// and its live push report it (HubStatus.peerAcceptsCommands, carried
// on the registry entry). A reading for the UI only (the app's useCommandAccess): the peer's direct
// listener enforces the switch on every call regardless.
export interface CommandAccess {
  granted: boolean;
  // No direct session yet, so the peer has not said.
  isLoading: boolean;
  // Whether a surface should offer commands right now: granted, or the
  // verdict not in yet (assume granted rather than flash a disabled
  // control that turns live a moment later).
  canCommand: boolean;
}
