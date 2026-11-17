// MCP over Streamable HTTP: JSON-RPC 2.0 on POST /mcp, answered as plain
// JSON. Modern discovery (server/discover) plus the legacy initialize
// handshake, a frozen tools list, and six tools that share the Store with
// REST, git and GraphQL.

import {
  globalId,
  nowIso,
  VIEWER,
  type Issue,
  type Store,
} from './store.ts';
import { createPullFromFields, mergePull } from './rest.ts';
import { jsonResult, type HttpResult } from './respond.ts';

const SERVER_NAME = 'forge-mcp';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSIONS = ['2026-07-28', '2025-06-18', '2025-03-26', '2024-11-05'];

// The tools list is a frozen constant: two tools/list calls answer byte-identical.
const TOOLS: Array<Record<string, unknown>> = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function rpcResult(id: unknown, result: unknown): HttpResult {
  return jsonResult(200, { jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string, status = 200): HttpResult {
  return jsonResult(status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function pickArg(args: Record<string, unknown>, names: string[]): unknown {
  for (const n of names) {
    if (args[n] !== undefined && args[n] !== null) return args[n];
  }
  return undefined;
}

function argString(args: Record<string, unknown>, names: string[]): string | null {
  const v = pickArg(args, names);
  if (typeof v === 'string' && v !== '') return v;
  if (typeof v === 'number') return String(v);
  return null;
}

function argNumber(args: Record<string, unknown>, names: string[]): number | null {
  const v = pickArg(args, names);
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
  return null;
}

/** Resolve owner/repo from arguments, accepting full_name "owner/repo" too. */
function ownerRepo(args: Record<string, unknown>): { owner: string; repo: string } | null {
  let owner = argString(args, ['owner', 'owner_login', 'login']);
  let repo = argString(args, ['repo', 'repository', 'repo_name']);
  const fullName = argString(args, ['full_name', 'fullName']);
  if ((!owner || !repo) && fullName && fullName.includes('/')) {
    const [o, r] = fullName.split('/');
    owner = owner ?? o;
    repo = repo ?? r;
  }
  if (!owner || !repo) return null;
  return { owner, repo };
}

function repoPayload(store: Store, name: string): Record<string, unknown> | null {
  const repo = store.getRepo(name);
  if (!repo) return null;
  return {
    id: repo.id,
    node_id: globalId('Repository', String(repo.id)),
    name: repo.name,
    full_name: `${VIEWER.login}/${repo.name}`,
    owner: { login: VIEWER.login, id: VIEWER.id },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issuePayload(repoName: string, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repoName}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: VIEWER.login, id: VIEWER.id },
    labels: issue.labels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
  };
}

function toolResult(payload: unknown): Record<string, unknown> {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { content: [{ type: 'text', text }], structuredContent: payload };
}

function toolErrorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], structuredContent: { error: message }, isError: true };
}

export function handleMcp(store: Store, body: Buffer): HttpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return rpcError(null, -32600, 'Invalid Request', 400);
  }
  const msg = parsed as Record<string, unknown>;
  const id = msg.id ?? null;
  const hasId = msg.id !== undefined;
  const method = typeof msg.method === 'string' ? msg.method : '';
  const params = (msg.params ?? {}) as Record<string, unknown>;

  // Notifications (no id) are acknowledged with an empty 202.
  if (!hasId) {
    return { status: 202, headers: {}, body: Buffer.alloc(0) };
  }

  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: PROTOCOL_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSIONS[0];
    return rpcResult(id, {
      protocolVersion: offered,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'ping') {
    return rpcResult(id, {});
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
    return rpcResult(id, callTool(store, name, args));
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = argString(args, ['name', 'repo', 'repository']);
      if (!repoName) return toolErrorResult('missing required argument: name');
      if (store.getRepo(repoName)) {
        const existing = repoPayload(store, repoName);
        return toolResult(existing);
      }
      const description = argString(args, ['description']) ?? '';
      const isPrivate = pickArg(args, ['private']) === true;
      const repo = store.createRepo(repoName, isPrivate, description);
      return toolResult(repoPayload(store, repo.name));
    }
    case 'get_repo': {
      const target = ownerRepo(args);
      if (!target) return toolErrorResult('missing required arguments: owner, repo');
      if (target.owner !== VIEWER.login) return toolErrorResult('Not Found');
      const payload = repoPayload(store, target.repo);
      if (!payload) return toolErrorResult('Not Found');
      return toolResult(payload);
    }
    case 'create_issue': {
      const target = ownerRepo(args);
      const title = argString(args, ['title']);
      if (!target) return toolErrorResult('missing required arguments: owner, repo');
      if (!title) return toolErrorResult('missing required argument: title');
      if (target.owner !== VIEWER.login) return toolErrorResult('Not Found');
      const repo = store.getRepo(target.repo);
      if (!repo) return toolErrorResult('Not Found');
      const now = nowIso();
      const issue: Issue = {
        id: store.nextIssueId(),
        number: ++repo.issueSeq,
        title,
        body: argString(args, ['body']) ?? '',
        state: 'open',
        labels: [],
        comments: [],
        seq: store.nextOpSeq(),
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        updatedSeq: store.nextOpSeq(),
        cachedBody: null,
      };
      repo.issues.push(issue);
      return toolResult(issuePayload(target.repo, issue));
    }
    case 'list_issues': {
      const target = ownerRepo(args);
      if (!target) return toolErrorResult('missing required arguments: owner, repo');
      if (target.owner !== VIEWER.login) return toolErrorResult('Not Found');
      const repo = store.getRepo(target.repo);
      if (!repo) return toolErrorResult('Not Found');
      const state = argString(args, ['state']) ?? 'open';
      const items = repo.issues.filter((i) => state === 'all' || i.state === state);
      const payload = items.map((i) => issuePayload(target.repo, i));
      return toolResult(payload);
    }
    case 'create_pull_request': {
      const target = ownerRepo(args);
      const title = argString(args, ['title']);
      const head = argString(args, ['head', 'head_ref', 'headRef']);
      const base = argString(args, ['base', 'base_ref', 'baseRef']);
      if (!target) return toolErrorResult('missing required arguments: owner, repo');
      if (!title || !head || !base) return toolErrorResult('missing required arguments: title, head, base');
      if (target.owner !== VIEWER.login) return toolErrorResult('Not Found');
      const repo = store.getRepo(target.repo);
      if (!repo) return toolErrorResult('Not Found');
      const created = createPullFromFields(store, repo, { title, body: argString(args, ['body']), head, base });
      if ('error' in created) return toolErrorResult('could not create pull request');
      const pull = created.pull;
      return toolResult({
        id: pull.id,
        node_id: globalId('PullRequest', `${repo.id}:${pull.number}`),
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        head: { ref: pull.headRef, sha: pull.headSha },
        base: { ref: pull.baseRef, sha: pull.baseSha },
        merged: false,
        created_at: pull.createdAt,
        updated_at: pull.updatedAt,
      });
    }
    case 'merge_pull_request': {
      const target = ownerRepo(args);
      const number = argNumber(args, ['pull_number', 'number', 'pull_request_number', 'pr_number']);
      if (!target) return toolErrorResult('missing required arguments: owner, repo');
      if (number === null) return toolErrorResult('missing required argument: pull_number');
      if (target.owner !== VIEWER.login) return toolErrorResult('Not Found');
      const repo = store.getRepo(target.repo);
      if (!repo) return toolErrorResult('Not Found');
      const pull = repo.pulls.find((p) => p.number === number);
      if (!pull) return toolErrorResult('Not Found');
      const merged = mergePull(repo, pull, null);
      if ('error' in merged) return toolErrorResult('could not merge pull request');
      return toolResult({
        sha: merged.sha,
        merged: true,
        number: pull.number,
        state: pull.state,
        merge_commit_sha: pull.mergeCommitSha,
        merged_at: pull.mergedAt,
      });
    }
    default:
      return toolErrorResult(`Unknown tool: ${name}`);
  }
}
