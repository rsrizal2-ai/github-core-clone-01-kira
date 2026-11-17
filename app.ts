// The forge server: one HTTP server, four surfaces. Routing, auth and the
// request-id header live here; the protocol work lives in gitproto.ts,
// rest.ts, graphql.ts and mcp.ts. A request that throws is answered 500 and
// the process keeps serving — a bad request must never kill the forge.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, VIEWER } from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitproto.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { jsonResult, notFound, unauthorized, type HttpResult } from './respond.ts';

const MAX_BODY_BYTES = 128 * 1024 * 1024;

const store = new Store();

/** Split a pathname into decoded, non-empty segments. */
function segmentsOf(pathname: string): string[] {
  const out: string[] = [];
  for (const part of pathname.split('/')) {
    if (part === '') continue;
    try {
      out.push(decodeURIComponent(part));
    } catch {
      out.push(part);
    }
  }
  return out;
}

function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return match[1].length > 0;
  return match[1] === expected;
}

/** Read a request body with plain data/end listeners (the fastest drain). */
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    req.on('data', (chunk: Buffer | string) => {
      if (done) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > MAX_BODY_BYTES) {
        done = true;
        req.pause();
        resolve(null);
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', () => {
      if (done) return;
      done = true;
      resolve(Buffer.alloc(0));
    });
  });
}

function dispatch(req: IncomingMessage, segments: string[], query: URLSearchParams, body: Buffer): HttpResult {
  const method = req.method ?? 'GET';

  // Health probe: no token, always 200.
  if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
    return jsonResult(200, { ok: true });
  }

  // Git smart HTTP: /{owner}/{repo}.git/info/refs, .../git-upload-pack, .../git-receive-pack
  const isGitRoute =
    segments.length >= 3 &&
    segments[1].endsWith('.git') &&
    ((segments.length === 4 && segments[2] === 'info' && segments[3] === 'refs') ||
      (segments.length === 3 && (segments[2] === 'git-upload-pack' || segments[2] === 'git-receive-pack')));
  if (isGitRoute) {
    if (!isAuthorized(req)) return unauthorized();
    const owner = segments[0];
    const repoName = segments[1].slice(0, -'.git'.length);
    if (owner !== VIEWER.login) return notFound();
    const repo = store.getRepo(repoName);
    if (!repo) return notFound();
    const wantsV2 = req.headers['git-protocol'] === 'version=2';
    const endpoint = segments.length === 4 ? 'info/refs' : segments[2];
    if (endpoint === 'info/refs' && method === 'GET') {
      const service = query.get('service') ?? '';
      return handleInfoRefs(repo, service, wantsV2);
    }
    if (endpoint === 'git-upload-pack' && method === 'POST') {
      return handleUploadPack(repo, body, wantsV2);
    }
    if (endpoint === 'git-receive-pack' && method === 'POST') {
      return handleReceivePack(repo, body);
    }
    return notFound();
  }

  // MCP: JSON-RPC over Streamable HTTP.
  if (segments.length === 1 && segments[0] === 'mcp') {
    if (method !== 'POST') return notFound();
    if (!isAuthorized(req)) return unauthorized();
    return handleMcp(store, body);
  }

  // GraphQL v4.
  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
    if (method !== 'POST') return notFound();
    if (!isAuthorized(req)) return unauthorized();
    return handleGraphQL(store, body);
  }

  // REST API v3.
  if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
    if (!isAuthorized(req)) return unauthorized();
    return handleRest(store, {
      method,
      segments,
      query,
      body,
      host: req.headers.host ?? '127.0.0.1',
    });
  }

  return notFound();
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  let requestCounter = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const requestId = `req-${(++requestCounter).toString(16).padStart(8, '0')}`;
      try {
        // Requests whose headers declare no body carry nothing to drain:
        // skip the stream entirely (most GETs, and the keep-alive hot path).
        const declaredLength = req.headers['content-length'];
        const hasBody =
          (declaredLength !== undefined && declaredLength !== '0') ||
          req.headers['transfer-encoding'] !== undefined;
        const body = hasBody ? await readBody(req) : Buffer.alloc(0);
        if (body === null) {
          const result = jsonResult(413, { message: 'Request body too large' });
          writeResult(res, result, requestId);
          return;
        }
        let url: URL;
        try {
          url = new URL(req.url ?? '/', 'http://entry');
        } catch {
          writeResult(res, jsonResult(400, { message: 'Bad Request' }), requestId);
          return;
        }
        const segments = segmentsOf(url.pathname);
        const result = dispatch(req, segments, url.searchParams, body);
        writeResult(res, result, requestId);
      } catch (err) {
        process.stderr.write(`[forge] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
        try {
          writeResult(res, jsonResult(500, { message: 'Internal Server Error' }), requestId);
        } catch {
          // The socket is already gone; nothing left to do.
        }
      }
    })();
  });
  server.on('clientError', (_err, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
    } catch {
      // Ignore socket errors.
    }
  });
  return server;
}

function writeResult(res: ServerResponse, result: HttpResult, requestId: string): void {
  const headers: Record<string, string> = {
    'x-github-request-id': requestId,
    ...result.headers,
  };
  if (result.status !== 204) {
    headers['content-length'] = String(result.body.length);
  }
  res.writeHead(result.status, headers);
  res.end(result.status === 204 ? undefined : result.body);
}

// A stray exception must never take the forge down mid-trial.
process.on('uncaughtException', (err) => {
  process.stderr.write(`[forge] uncaught: ${err instanceof Error ? err.message : String(err)}\n`);
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[forge] unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}\n`);
});
