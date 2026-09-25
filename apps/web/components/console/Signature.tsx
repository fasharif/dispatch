import type { Signature as SignatureData } from '@dispatch/shared';
import { signaturePath } from '@/lib/format';

/** The recipient's signature, drawn from the strokes the driver app captured. */
export function Signature({ signature, label }: { signature: SignatureData; label: string }) {
  return (
    <svg
      className="signature"
      viewBox={`0 0 ${String(signature.width)} ${String(signature.height)}`}
      role="img"
      aria-label={label}
    >
      <path
        d={signaturePath(signature.strokes)}
        fill="none"
        stroke="currentColor"
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
