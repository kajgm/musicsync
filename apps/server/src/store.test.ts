import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from './store.ts';

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'musicsync-store-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Store', () => {
  it('keeps settings and encrypted secrets across reopening', () => {
    const dir = tempDir();
    const key = Buffer.alloc(32, 7);
    const a = new Store(dir, key);
    a.set('master', { brightness: 0.5 });
    a.setSecret('hue', { appKey: 'k' });
    expect(a.get<string>('secret:hue')).not.toContain('appKey');
    a.close();
    const b = new Store(dir, key);
    expect(b.get('master')).toEqual({ brightness: 0.5 });
    expect(b.getSecret('hue')).toEqual({ appKey: 'k' });
    b.close();
  });

  it('refuses secrets under another master key or moved to another name', () => {
    const dir = tempDir();
    const a = new Store(dir, Buffer.alloc(32, 1));
    a.setSecret('hue', { appKey: 'k' });
    a.set('secret:spotify', a.get('secret:hue'));
    expect(() => a.getSecret('spotify')).toThrow(/decrypt/);
    a.close();
    const b = new Store(dir, Buffer.alloc(32, 2));
    expect(() => b.getSecret('hue')).toThrow(/MUSICSYNC_MASTER_KEY/);
    b.close();
  });
});
