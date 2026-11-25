// One SQLite file for settings and secrets. Secrets (Hue keys, Spotify tokens, the agent
// token) are AES-256-GCM encrypted with the master key, bound to their key name.
// shortcut: a key-value table (the layout is one document in it, decision 0002); add tables when something needs querying.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class Store {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;

  constructor(dataDir: string, masterKey: Buffer) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'musicsync.db'));
    this.db.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.key = masterKey;
  }

  get<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  }

  getSecret<T>(key: string): T | undefined {
    const sealed = this.get<string>(`secret:${key}`);
    if (!sealed) return undefined;
    const buf = Buffer.from(sealed, 'base64');
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, buf.subarray(0, 12));
      decipher.setAAD(Buffer.from(key));
      decipher.setAuthTag(buf.subarray(12, 28));
      return JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8')) as T;
    } catch {
      throw new Error(`Can't decrypt the stored ${key} secret: was MUSICSYNC_MASTER_KEY changed? Set it up again.`);
    }
  }

  setSecret(key: string, value: unknown): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(key));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    this.set(`secret:${key}`, Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64'));
  }

  deleteSecret(key: string): void {
    this.delete(`secret:${key}`);
  }

  close(): void {
    this.db.close();
  }
}
