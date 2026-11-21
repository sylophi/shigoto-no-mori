// What sm keeps of this device beside its enrollment, which Colibrii
// keeps (the host's PeerDevice.ts, the web client's tab): the name it
// enrolls under, the icon its owner picked, and the account its command
// switch is on for. A sign-out keeps the name and the icon. The shells
// keep it where they kept the account before, so a name and an icon
// picked on an older build read here as they were.
import { type DeviceIcon, isDeviceIcon } from "@shigomori/contracts/deviceIcon";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export type Profile = {
  readonly deviceName?: string;
  // Absent, the device wears the icon it detects.
  readonly deviceIcon?: DeviceIcon;
  readonly acceptsCommandsFor?: string;
};

export type ProfileStore = {
  readonly read: () => Profile;
  readonly write: (profile: Profile) => void;
};

const decode = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      deviceName: Schema.optional(Schema.String),
      deviceIcon: Schema.optional(Schema.Unknown),
      acceptsCommandsFor: Schema.optional(Schema.String),
    }),
  ),
);

export const profileStore = (storage: {
  readonly readRaw: () => string | null;
  readonly writeRaw: (text: string) => void;
}): ProfileStore => ({
  read: () => {
    const raw = storage.readRaw();
    const doc = raw === null ? undefined : Option.getOrUndefined(decode(raw));
    return {
      ...(doc?.deviceName === undefined || doc.deviceName === ""
        ? {}
        : { deviceName: doc.deviceName }),
      ...(isDeviceIcon(doc?.deviceIcon) ? { deviceIcon: doc.deviceIcon } : {}),
      ...(doc?.acceptsCommandsFor === undefined
        ? {}
        : { acceptsCommandsFor: doc.acceptsCommandsFor }),
    };
  },
  write: (profile) => storage.writeRaw(JSON.stringify(profile)),
});
