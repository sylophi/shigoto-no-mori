// The refusal markers a byte-stream open answers with, stable strings
// rather than prose (Electron IPC and the device wires preserve only
// the message), so the client side and the UI can match on them.
export const CHANNEL_OPEN_NO_CHANNELS = "no-byte-channels";
export const CHANNEL_OPEN_TAKEN = "channel-taken";
// The connection already holds as many streams as it may
// (MAX_CHANNELS_PER_LINK, app/shared/remote/link.ts). The forward UI names it
// (renderer/hooks/remote/usePortForwards.ts).
export const CHANNEL_OPEN_TOO_MANY = "too-many-conns";
