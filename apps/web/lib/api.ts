import type { ApiErrorBody } from '@dispatch/shared';
import { API_URL } from './config';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody | null,
  ) {
    super(body?.message ?? `Request failed with status ${String(status)}`);
    this.name = 'ApiRequestError';
  }

  get code(): string | undefined {
    return this.body?.code;
  }
}

export interface RequestOptions {
  token?: string | null;
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
}

/** JSON request to the dispatch API. Errors carry the API's error envelope. */
export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
      cache: 'no-store',
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiRequestError(0, {
      statusCode: 0,
      error: 'Network Error',
      message: 'The dispatch service cannot be reached. Check your connection.',
    });
  }
  const text = await response.text();
  if (!response.ok) {
    let body: ApiErrorBody | null = null;
    try {
      body = JSON.parse(text) as ApiErrorBody;
    } catch {
      body = null;
    }
    throw new ApiRequestError(response.status, body);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Fetches a binary resource (the proof-of-delivery photo) and returns an object URL for <img>. */
export async function apiBlobUrl(path: string, token: string): Promise<string> {
  const response = await fetch(`${API_URL}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new ApiRequestError(response.status, null);
  return URL.createObjectURL(await response.blob());
}
