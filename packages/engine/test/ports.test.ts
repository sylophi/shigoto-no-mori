import assert from "node:assert/strict";
import { it } from "vitest";
import { matchPorts, type PortPoolConfig } from "../src/ports.ts";

const config: PortPoolConfig = {
  configured: true,
  portNames: ["web", "api", "db"],
  envFiles: {
    ".env": { PORT: "${web}", API_URL: "http://localhost:${api}" },
    "server/.env": { PORT: "${api}", DB_PORT: "${db}", WEB: "${web}" },
  },
};

it("reads each port out of the files port-pool wrote, the first file to carry a name winning", () => {
  const files = new Map([
    [
      ".env",
      "# written by port-pool\nexport PORT='4100'\nAPI_URL=http://localhost:4200\n",
    ],
    ["server/.env", 'PORT="4200"\nDB_PORT=x\nWEB=4999\n'],
  ]);
  assert.deepEqual(matchPorts(config, files), [
    { name: "web", port: 4100, file: ".env", key: "PORT" },
    { name: "api", port: 4200, file: "server/.env", key: "PORT" },
  ]);
});

it("skips a file that isn't there", () => {
  assert.deepEqual(
    matchPorts(config, new Map([["server/.env", "DB_PORT=5432"]])),
    [{ name: "db", port: 5432, file: "server/.env", key: "DB_PORT" }],
  );
});
