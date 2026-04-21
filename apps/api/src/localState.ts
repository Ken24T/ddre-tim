import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(moduleDirectory, "../../..");
const localStateDirectory = resolve(workspaceRoot, "infra/local-state");

async function ensureLocalStateDirectory(): Promise<void> {
  await mkdir(localStateDirectory, { recursive: true });
}

export function resolveLocalStatePath(fileName: string): string {
  return resolve(localStateDirectory, fileName);
}

export async function readLocalStateJson<T>(fileName: string, fallback: T): Promise<T> {
  try {
    const fileContents = await readFile(resolveLocalStatePath(fileName), "utf8");
    return JSON.parse(fileContents) as T;
  } catch (error) {
    const typedError = error as NodeJS.ErrnoException;

    if (typedError.code === "ENOENT") {
      return fallback;
    }

    throw error;
  }
}

export async function writeLocalStateJson(fileName: string, value: unknown): Promise<void> {
  await ensureLocalStateDirectory();

  const targetPath = resolveLocalStatePath(fileName);
  const temporaryPath = `${targetPath}.tmp`;

  await writeFile(temporaryPath, JSON.stringify(value, null, 2));
  await rename(temporaryPath, targetPath);
}