/**
 * Connection failures worth another attempt: the server is starting, restarting or unreachable
 * for a moment (a container that has just become healthy, a proxy resetting a new connection).
 */
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', '57P03']);

export function isRetryableConnectionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && RETRYABLE_CODES.has(code);
}

/**
 * Runs an idempotent database task again after a connection failure, waiting a little longer
 * each time. Used by the migration and seed commands, which run once at start-up.
 */
export async function retryConnection<T>(
  task: () => Promise<T>,
  options: { attempts?: number; delayMs?: number; log?: (message: string) => void } = {},
): Promise<T> {
  const attempts = options.attempts ?? 5;
  const delayMs = options.delayMs ?? 1_000;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      if (attempt >= attempts || !isRetryableConnectionError(error)) throw error;
      options.log?.(
        `Database connection failed (${(error as { code: string }).code}), attempt ` +
          `${String(attempt)} of ${String(attempts)}; retrying`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}
