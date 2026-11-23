// Gitignored store for credentials and measurement logs (spikes/.local/).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOCAL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.local');

export function localPath(name: string): string {
  mkdirSync(LOCAL_DIR, { recursive: true });
  return join(LOCAL_DIR, name);
}

export function readLocal<T>(name: string): T | undefined {
  const path = join(LOCAL_DIR, name);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function writeLocal(name: string, value: unknown): void {
  writeFileSync(localPath(name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
