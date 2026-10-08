import { decodeChunk } from './base64';

describe('bounded chunk decoder', () => {
  it('preserves binary bytes including null and high values without Buffer or browser APIs', () => {
    for (const bytes of [[0], [0, 255], [0, 128, 255], [37, 80, 68, 70]]) {
      expect([...decodeChunk(Buffer.from(bytes).toString('base64'))]).toEqual(bytes);
    }
  });
  it('rejects malformed and oversized data before allocating an output', () => {
    for (const value of ['!!!!', 'YQ', 'YQ==evil', 'YQ==\n', 'A'.repeat(87384) + 'AAAA']) expect(() => decodeChunk(value)).toThrow();
  });
  it('decodes the maximum 64KiB chunk exactly', () => {
    const bytes = Buffer.alloc(65536, 255); expect(Buffer.from(decodeChunk(bytes.toString('base64'))).equals(bytes)).toBe(true);
  });
});
