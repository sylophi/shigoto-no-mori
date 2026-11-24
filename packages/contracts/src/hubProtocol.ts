// The account's devices as the hub lists them and every side shows them.
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import {
  DEVICE_ICONS,
  fallbackDeviceIcon,
  isDeviceIcon,
} from "./deviceIcon.ts";

export const DeviceIdSchema = Schema.NonEmptyString.check(
  Schema.isMaxLength(200),
);

// A device id as every device mints its own, a UUID: what a device
// keeps of a stored one, minting afresh for anything else.
export const isMintedDeviceId = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

// An icon this build's catalog lacks reads as its platform's.
const DeviceInfoWireSchema = Schema.Struct({
  deviceId: Schema.String,
  name: Schema.String,
  platform: Schema.String,
  icon: Schema.String,
  createdAt: Schema.Int,
  lastSeenAt: Schema.NullOr(Schema.Int),
  online: Schema.Boolean,
});
export const DeviceInfoSchema = DeviceInfoWireSchema.pipe(
  Schema.decodeTo(
    Schema.Struct({
      ...DeviceInfoWireSchema.fields,
      icon: Schema.Literals(DEVICE_ICONS),
    }),
    SchemaTransformation.transform({
      decode: (info) => ({
        ...info,
        icon: isDeviceIcon(info.icon)
          ? info.icon
          : fallbackDeviceIcon(info.platform),
      }),
      encode: (info) => info,
    }),
  ),
);
export type DeviceInfo = typeof DeviceInfoSchema.Type;
