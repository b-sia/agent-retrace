/**
 * A tiny local HTTP server for integration tests, standing in for a provider.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** A running test server. */
export interface TestServer {
  /** Base URL, e.g. `http://127.0.0.1:41234`. */
  url: string;
  /** `host:port`, the form `configure({ providerHosts })` accepts. */
  host: string;
  /** Number of requests received so far. */
  hits: number;
  /** Stops the server and drops open connections. */
  close(): Promise<void>;
}

/**
 * Starts a server on a random port of 127.0.0.1.
 *
 * @param handler - Called for every request; it must end the response.
 * @returns The running server.
 */
export async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void,
): Promise<TestServer> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => handler(req, res, Buffer.concat(chunks)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const result: TestServer = {
    url: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    hits: 0,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  // Counted before the handler runs, so a test can assert on `hits` after the response.
  server.prependListener("request", () => {
    result.hits++;
  });
  return result;
}
