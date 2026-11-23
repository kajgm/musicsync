import { describe, expect, it } from 'vitest';
import { hueStreamBuffer, writeColors } from './stream.ts';

const AREA = '1a8d99cc-967b-44f2-9202-43f976c0fa6b';

describe('HueStream v2 encoding', () => {
  it('writes the header, then 7 bytes per channel', () => {
    const buf = hueStreamBuffer(AREA, [0, 3]);
    writeColors(buf, Float32Array.of(1, 0, 0.5, 0, 2, -1), 257);
    expect(buf.length).toBe(52 + 2 * 7);
    expect(buf.subarray(0, 9).toString('ascii')).toBe('HueStream');
    expect([buf[9], buf[10], buf[11], buf[14]]).toEqual([2, 0, 1, 0]); // v2.0, sequence 257 & 0xff, RGB
    expect(buf.subarray(16, 52).toString('ascii')).toBe(AREA);
    expect([...buf.subarray(52)]).toEqual([
      0, 0xff, 0xff, 0x00, 0x00, 0x80, 0x00, // channel 0: 1, 0, 0.5
      3, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00, // channel 3: clamped to 0, 1, 0
    ]);
  });
});
