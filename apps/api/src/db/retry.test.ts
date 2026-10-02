import { describe, expect, it, vi } from 'vitest';
import { isRetryableConnectionError, retryConnection } from './retry.js';

const failure = (code: string) => Object.assign(new Error(code), { code });

describe('retryConnection', () => {
  it('repeats a task after connection failures until it succeeds', async () => {
    const task = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(failure('ECONNRESET'))
      .mockRejectedValueOnce(failure('57P03'))
      .mockResolvedValue('done');
    const log = vi.fn();
    await expect(retryConnection(task, { delayMs: 1, log })).resolves.toBe('done');
    expect(task).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('gives up after the last attempt', async () => {
    const task = vi.fn<() => Promise<void>>().mockRejectedValue(failure('ECONNREFUSED'));
    await expect(retryConnection(task, { attempts: 3, delayMs: 1 })).rejects.toThrow(
      'ECONNREFUSED',
    );
    expect(task).toHaveBeenCalledTimes(3);
  });

  it('does not repeat other errors, such as a failing migration', async () => {
    const task = vi.fn<() => Promise<void>>().mockRejectedValue(failure('42P01'));
    await expect(retryConnection(task, { delayMs: 1 })).rejects.toThrow('42P01');
    expect(task).toHaveBeenCalledTimes(1);
    expect(isRetryableConnectionError(new Error('no code'))).toBe(false);
    expect(isRetryableConnectionError(null)).toBe(false);
  });
});
