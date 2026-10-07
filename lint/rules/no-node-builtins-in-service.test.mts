import { testRule } from "../ruleTester.mts";
import rule from "./no-node-builtins-in-service.mts";

const service = "engine/src/Registry.ts";

testRule("no-node-builtins-in-service", rule, {
  valid: [
    {
      code: 'import * as FileSystem from "effect/FileSystem";',
      filename: service,
    },
    {
      code: 'import { join } from "node:path";',
      filename: "engine/src/paths.ts",
    },
    {
      code: 'import { join } from "node:path";',
      filename: "engine/src/Registry.test.ts",
    },
    { code: 'import { createHash } from "node:crypto";', filename: service },
    { code: 'import * as osx from "osx-utils";', filename: service },
  ],
  invalid: [
    { code: 'import * as fs from "node:fs";', filename: service, errors: 1 },
    {
      code: 'import { readFile } from "node:fs/promises";',
      filename: service,
      errors: 1,
    },
    {
      code: 'import { spawn } from "child_process";',
      filename: service,
      errors: 1,
    },
    {
      code: 'import { homedir } from "node:os";',
      filename: service,
      errors: 1,
    },
    { code: 'import path from "path";', filename: service, errors: 1 },
    { code: 'export { join } from "node:path";', filename: service, errors: 1 },
    {
      code: 'const fs = await import("node:fs");',
      filename: service,
      errors: 1,
    },
    { code: 'const fs = require("fs");', filename: service, errors: 1 },
  ],
});
