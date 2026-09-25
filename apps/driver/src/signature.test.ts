import { signatureSchema } from '@dispatch/shared';
import { describe, expect, it } from 'vitest';
import { MAX_SIGNATURE_POINTS, toSignature, type Stroke } from './signature';

describe('toSignature', () => {
  it('flattens strokes into whole-pixel pairs inside the pad', () => {
    const signature = toSignature(
      [
        [
          { x: 10.4, y: 20.6 },
          { x: -5, y: 400 },
        ],
      ],
      300.2,
      150,
    );
    expect(signature).toEqual({ width: 300, height: 150, strokes: [[10, 21, 0, 150]] });
    expect(signatureSchema.safeParse(signature).success).toBe(true);
  });

  it('keeps a tap as a dot and ignores empty strokes', () => {
    const signature = toSignature([[], [{ x: 5, y: 5 }]], 300, 150);
    expect(signature?.strokes).toEqual([[5, 5, 5, 5]]);
  });

  it('returns nothing for an empty pad', () => {
    expect(toSignature([], 300, 150)).toBeNull();
    expect(toSignature([[]], 300, 150)).toBeNull();
  });

  it('thins very long signatures to what the API accepts', () => {
    const long: Stroke = Array.from({ length: 12_000 }, (_, i) => ({ x: i % 300, y: i % 150 }));
    const signature = toSignature([long, long], 300, 150);
    const points = (signature?.strokes ?? []).reduce((sum, s) => sum + s.length / 2, 0);
    expect(points).toBeLessThanOrEqual(MAX_SIGNATURE_POINTS);
    expect(signatureSchema.safeParse(signature).success).toBe(true);
  });
});
