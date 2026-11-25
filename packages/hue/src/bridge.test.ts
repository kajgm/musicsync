import { describe, expect, it } from 'vitest';
import { isDeviceChange } from './bridge.ts';

const event = (type: string, data: unknown[]) => JSON.stringify([{ type, data }]);

describe('isDeviceChange', () => {
  it('reacts to lights added, removed or renamed', () => {
    expect(isDeviceChange(event('add', [{ type: 'light', id: 'x' }]))).toBe(true);
    expect(isDeviceChange(event('delete', [{ type: 'entertainment', id: 'x' }]))).toBe(true);
    expect(isDeviceChange(event('update', [{ type: 'device', metadata: { name: 'Lamp' } }]))).toBe(true);
  });

  it('ignores colour changes, other resources and junk', () => {
    expect(isDeviceChange(event('update', [{ type: 'light', dimming: { brightness: 50 } }]))).toBe(false);
    expect(isDeviceChange(event('add', [{ type: 'scene' }]))).toBe(false);
    expect(isDeviceChange('not json')).toBe(false);
  });
});
