// Read shigoto.json from a project's root.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ShigotoConfig, ShigotoConfigSchema } from "@shared/schemas";

export async function readShigotoConfig(
  projectPath: string,
): Promise<ShigotoConfig | null> {
  const path = join(projectPath, "shigoto.json");
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    return ShigotoConfigSchema.parse(parsed);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    // Surface parse / schema errors so a bad config doesn't fail silently.
    throw new Error(`Failed to read shigoto.json at ${path}`, {
      cause: error,
    });
  }
}
