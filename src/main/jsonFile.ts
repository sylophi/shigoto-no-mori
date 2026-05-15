// Atomic JSON read/write helpers used by globalConfig.ts and shigomori.ts.
// Both files keep their own caches; only the disk IO is shared here.
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { z } from "zod";
import { isENOENT } from "./paths";

export async function readJsonOrNull<T>(
  filePath: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    return schema.parse(JSON.parse(raw));
  } catch (error) {
    if (isENOENT(error)) return null;
    throw new Error(`Failed to read ${filePath}`, { cause: error });
  }
}

export async function atomicWriteJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await rename(temp, filePath);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}
