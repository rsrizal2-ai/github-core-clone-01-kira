// Small response helpers shared by every surface (REST, git, GraphQL, MCP).

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const JSON_TYPE = 'application/json; charset=utf-8';

export { JSON_TYPE };

export function jsonResult(status: number, body: unknown, extra: Record<string, string> = {}): HttpResult {
  return {
    status,
    headers: { 'content-type': JSON_TYPE, ...extra },
    body: Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'),
  };
}

export function bufferResult(status: number, body: Buffer, contentType: string, extra: Record<string, string> = {}): HttpResult {
  return { status, headers: { 'content-type': contentType, ...extra }, body };
}

export function textResult(status: number, text: string, extra: Record<string, string> = {}): HttpResult {
  return {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...extra },
    body: Buffer.from(text, 'utf8'),
  };
}

export function emptyResult(status: number, extra: Record<string, string> = {}): HttpResult {
  return { status, headers: { ...extra }, body: Buffer.alloc(0) };
}

export function notFound(message = 'Not Found'): HttpResult {
  return jsonResult(404, { message });
}

export function badRequest(message: string): HttpResult {
  return jsonResult(400, { message });
}

export function unauthorized(message = 'Bad credentials'): HttpResult {
  return jsonResult(401, { message });
}

export function unprocessable(message: string): HttpResult {
  return jsonResult(422, { message });
}
