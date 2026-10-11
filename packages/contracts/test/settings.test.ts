// Every setting the terminal lists says what it is for: its description
// is its field's (`annotateKey`), so a new key without one fails here.
import assert from "node:assert/strict";
import { it } from "vitest";
import {
  DeviceSettingsPatchSchema,
  keyDescriptions,
  ShigomoriConfigSchema,
} from "../src/schemas/config.ts";

it("describes every device and project setting", () => {
  for (const schema of [
    DeviceSettingsPatchSchema.struct,
    ShigomoriConfigSchema,
  ]) {
    const undescribed = Object.entries(keyDescriptions(schema))
      .filter(([, description]) => description === "")
      .map(([key]) => key);
    assert.deepEqual(undescribed, []);
  }
});
