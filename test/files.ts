import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("..", import.meta.url));

export function readText(path: string): Promise<string> {
  return Bun.file(join(root, path)).text();
}

export async function exists(path: string): Promise<boolean> {
  return Bun.file(join(root, path)).exists();
}

export async function list(pattern: string): Promise<string[]> {
  return (await Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: root }))).sort();
}
