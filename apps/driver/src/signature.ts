import type { Signature } from '@dispatch/shared';

/** The API's limit on the total number of points in a signature (see signatureSchema). */
export const MAX_SIGNATURE_POINTS = 5_000;
const MAX_STROKES = 200;
/** One stroke carries at most 4 000 numbers: 2 000 points. */
const MAX_STROKE_POINTS = 2_000;

export type Stroke = { x: number; y: number }[];

/**
 * Converts strokes captured on the pad into the API's format: flat [x0, y0, x1, y1, …] lists of
 * whole pixels inside the pad. Strokes with a single point (a tap) are kept as a dot. When the
 * signature has more points than the API accepts, every stroke is thinned evenly.
 */
export function toSignature(
  strokes: readonly Stroke[],
  width: number,
  height: number,
): Signature | null {
  const w = Math.round(width);
  const h = Math.round(height);
  const usable = strokes.filter((stroke) => stroke.length > 0).slice(0, MAX_STROKES);
  if (usable.length === 0) return null;
  const total = usable.reduce((sum, stroke) => sum + Math.max(stroke.length, 2), 0);
  // Every stroke also keeps its last point (and a dot has two), so leave room for those.
  const budget = MAX_SIGNATURE_POINTS - 2 * usable.length;
  const step = Math.max(1, Math.ceil(total / budget));

  const clamp = (value: number, max: number) => Math.min(max, Math.max(0, Math.round(value)));
  return {
    width: w,
    height: h,
    strokes: usable.map((stroke) => {
      const strokeStep = Math.max(step, Math.ceil(stroke.length / (MAX_STROKE_POINTS - 1)));
      const kept = stroke.filter(
        (_, index) => index % strokeStep === 0 || index === stroke.length - 1,
      );
      const points = kept.length === 1 && kept[0] ? [kept[0], kept[0]] : kept;
      return points.flatMap((point) => [clamp(point.x, w), clamp(point.y, h)]);
    }),
  };
}
