// Per-user global config at ~/shigomori[-dev]/config.json. Holds preferences
// that span every project — currently just custom launchers — and is kept
// separate from state.json (runtime data) and shigomori.config.json (committed
// per-project config).
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type GlobalConfig, GlobalConfigSchema } from "@shared/schemas";
import { shigomoriRoot } from "./paths";

const CACHE_TTL_MS = 5_000;
let cached: { value: GlobalConfig; expires: number } | null = null;

function configPath(): string {
  return join(shigomoriRoot(), "config.json");
}

export async function readGlobalConfig(): Promise<GlobalConfig> {
  const now = Date.now();
  if (cached && cached.expires > now) return cached.value;

  const path = configPath();
  let value: GlobalConfig;
  try {
    const raw = await readFile(path, "utf8");
    value = GlobalConfigSchema.parse(JSON.parse(raw));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      value = {};
    } else {
      throw new Error(`Failed to read ${path}`, { cause: error });
    }
  }

  cached = { value, expires: now + CACHE_TTL_MS };
  return value;
}

export async function writeGlobalConfig(config: GlobalConfig): Promise<void> {
  const validated = GlobalConfigSchema.parse(config);
  const target = configPath();
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.tmp.${process.pid}.${Date.now()}`;
  const json = `${JSON.stringify(validated, null, 2)}\n`;
  await writeFile(temp, json, "utf8");
  try {
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  cached = null;
}
