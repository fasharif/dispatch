import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface LocalServer {
  url: string;
  requests: { method: string; url: string; headers: IncomingMessage['headers']; body: string }[];
  close(): Promise<void>;
}

/**
 * A throwaway HTTP server on 127.0.0.1 for unit tests of outbound HTTP (webhooks, OSRM).
 * Not part of the application.
 */
export async function localServer(
  handler: (request: IncomingMessage, response: ServerResponse, body: string) => void,
): Promise<LocalServer> {
  const requests: LocalServer['requests'] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body,
      });
      handler(request, response, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
