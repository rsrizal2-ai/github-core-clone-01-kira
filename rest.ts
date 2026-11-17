// REST API v3: repositories, git refs, branches, commits, contents, labels,
// issues and pull requests. All state lives in the shared Store, so anything
// written here is visible to git, GraphQL and MCP, and vice versa.

import {
  branchTip,
  commitOnBranch,
  commitWithParent,
  diffFlats,
  flattenTree,
  getCommit,
  getObject,
  getTree,
  globalId,
  invalidateIssue,
  isHex40,
  mergeBase,
  nowIso,
  peelToCommit,
  putObject,
  resolveRef,
  squashMergeTree,
  VIEWER,
  walkCommits,
  type Comment,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { badRequest, bufferResult, emptyResult, jsonResult, JSON_TYPE, notFound, unprocessable, type HttpResult } from './respond.ts';

const SCOPES = 'repo, read:org';

export interface RestRequest {
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: Buffer;
  host: string;
}

// The viewer never changes during a trial, so the user object is built once
// and shared by every response that embeds it (it is only ever stringified).
let cachedUser: Record<string, unknown> | null = null;

function userJson(): Record<string, unknown> {
  if (cachedUser) return cachedUser;
  cachedUser = {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: globalId('User', String(VIEWER.id)),
    avatar_url: '',
    gravatar_id: '',
    url: `/api/v3/users/${VIEWER.login}`,
    html_url: `https://github.invalid/${VIEWER.login}`,
    type: 'User',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
    company: null,
    blog: '',
    location: null,
    bio: null,
    public_repos: 0,
    public_gists: 0,
    followers: 0,
    following: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: nowIso(),
  };
  return cachedUser;
}

function repoJson(repo: Repo): Record<string, unknown> {
  const owner = VIEWER.login;
  return {
    id: repo.id,
    node_id: globalId('Repository', String(repo.id)),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: VIEWER.id, node_id: globalId('User', String(VIEWER.id)), type: 'User', site_admin: false },
    private: repo.private,
    html_url: `https://github.invalid/${owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    git_url: `git://github.invalid/${owner}/${repo.name}.git`,
    ssh_url: `git@github.invalid:${owner}/${repo.name}.git`,
    clone_url: `https://github.invalid/${owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length + repo.pulls.filter((p) => p.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(label: Label, repo: Repo): Record<string, unknown> {
  return {
    id: label.id,
    node_id: globalId('Label', `${repo.id}:${label.id}`),
    url: `/api/v3/repos/${VIEWER.login}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

function issueJson(issue: Issue, repo: Repo): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.id}:${issue.number}`),
    url: `/api/v3/repos/${VIEWER.login}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${VIEWER.login}/${repo.name}`,
    html_url: `https://github.invalid/${VIEWER.login}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: userJson(),
    labels: issue.labels.map((l) => labelJson(l, repo)),
    assignees: [],
    locked: false,
    active_lock_reason: null,
    comments: issue.comments.length,
    closed_at: issue.closedAt,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    author_association: 'OWNER',
    state_reason: null,
    milestone: null,
  };
}

function commentJson(comment: Comment, repo: Repo, issueNumber: number): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', `${repo.id}:${comment.id}`),
    url: `/api/v3/repos/${VIEWER.login}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `https://github.invalid/${VIEWER.login}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    issue_url: `/api/v3/repos/${VIEWER.login}/${repo.name}/issues/${issueNumber}`,
    body: comment.body,
    user: userJson(),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
  };
}

function pullSideJson(ref: string, sha: string, repo: Repo): Record<string, unknown> {
  return {
    label: `${VIEWER.login}:${ref}`,
    ref,
    sha,
    user: userJson(),
    repo: {
      id: repo.id,
      node_id: globalId('Repository', String(repo.id)),
      name: repo.name,
      full_name: `${VIEWER.login}/${repo.name}`,
      owner: { login: VIEWER.login, id: VIEWER.id },
      private: repo.private,
      default_branch: repo.defaultBranch,
    },
  };
}

function pullJson(pull: Pull, repo: Repo): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.id}:${pull.number}`),
    url: `/api/v3/repos/${VIEWER.login}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.invalid/${VIEWER.login}/${repo.name}/pull/${pull.number}`,
    diff_url: `https://github.invalid/${VIEWER.login}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `https://github.invalid/${VIEWER.login}/${repo.name}/pull/${pull.number}.patch`,
    issue_url: `/api/v3/repos/${VIEWER.login}/${repo.name}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userJson(),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: pull.state === 'open' ? true : null,
    rebaseable: true,
    mergeable_state: pull.merged ? 'merged' : pull.state === 'closed' ? 'closed' : 'clean',
    merged_by: pull.merged ? userJson() : null,
    comments: 0,
    review_comments: 0,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    head: pullSideJson(pull.headRef, pull.headSha, repo),
    base: pullSideJson(pull.baseRef, pull.baseSha, repo),
    draft: false,
    maintainer_can_modify: false,
    author_association: 'OWNER',
    auto_merge: null,
  };
}

function parseIdentity(line: string): { name: string; email: string; date: string } {
  const lt = line.indexOf('<');
  const gt = line.indexOf('>', lt);
  const name = lt > 0 ? line.slice(0, lt).trim() : line;
  const email = lt !== -1 && gt !== -1 ? line.slice(lt + 1, gt) : '';
  const rest = gt !== -1 ? line.slice(gt + 1).trim().split(' ') : [];
  const ts = rest.length > 0 ? parseInt(rest[0], 10) : NaN;
  const date = Number.isFinite(ts) ? new Date(ts * 1000).toISOString() : nowIso();
  return { name, email, date };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const commit = getCommit(repo, sha);
  if (!commit) return null;
  const author = parseIdentity(commit.author);
  const committer = parseIdentity(commit.committer);
  return {
    sha,
    node_id: globalId('Commit', `${repo.id}:${sha}`),
    url: `/api/v3/repos/${VIEWER.login}/${repo.name}/commits/${sha}`,
    html_url: `https://github.invalid/${VIEWER.login}/${repo.name}/commit/${sha}`,
    comments_url: `/api/v3/repos/${VIEWER.login}/${repo.name}/commits/${sha}/comments`,
    commit: {
      author,
      committer,
      message: commit.message,
      tree: { sha: commit.tree, url: `/api/v3/repos/${VIEWER.login}/${repo.name}/git/trees/${commit.tree}` },
      url: `/api/v3/repos/${VIEWER.login}/${repo.name}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    author: userJson(),
    committer: userJson(),
    parents: commit.parents.map((p) => ({
      sha: p,
      url: `/api/v3/repos/${VIEWER.login}/${repo.name}/commits/${p}`,
      html_url: `https://github.invalid/${VIEWER.login}/${repo.name}/commit/${p}`,
    })),
  };
}

function parseJsonBody(body: Buffer): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function paginate<T>(items: T[], query: URLSearchParams, host: string, path: string): { page: T[]; link: string | null } {
  const { page, perPage } = pageParams(query);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const base = `http://${host}${path}`;
  const other = new URLSearchParams(query);
  const linkFor = (p: number, rel: string): string => {
    other.set('page', String(p));
    other.set('per_page', String(perPage));
    return `<${base}?${other.toString()}>; rel="${rel}"`;
  };
  const links: string[] = [];
  if (page < totalPages) links.push(linkFor(page + 1, 'next'));
  if (totalPages > 1) links.push(linkFor(totalPages, 'last'));
  if (page > 1) {
    links.push(linkFor(1, 'first'));
    links.push(linkFor(page - 1, 'prev'));
  }
  return { page: slice, link: links.length > 0 ? links.join(', ') : null };
}

function withLink(result: HttpResult, link: string | null): HttpResult {
  if (link) result.headers['link'] = link;
  return result;
}

function normalizeBranch(ref: string): string {
  let out = ref;
  if (out.startsWith('refs/heads/')) out = out.slice('refs/heads/'.length);
  const colon = out.indexOf(':');
  if (colon !== -1) out = out.slice(colon + 1);
  return out;
}

/** Navigate a tree by path parts; returns the subtree entries or null. */
function subtreeAt(repo: Repo, treeOid: string, parts: string[]): { oid: string; entries: ReturnType<typeof getTree> } | null {
  let cur = treeOid;
  for (const part of parts) {
    const entries = getTree(repo, cur);
    if (!entries) return null;
    const found = entries.find((e) => e.name === part && e.mode === '40000');
    if (!found) return null;
    cur = found.oid;
  }
  return { oid: cur, entries: getTree(repo, cur) };
}

export function handleRest(store: Store, req: RestRequest): HttpResult {
  const { method, segments, query } = req;
  const seg = segments;

  // API root and meta.
  if (seg.length === 2 && method === 'GET') {
    return jsonResult(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': SCOPES });
  }
  if (seg.length === 3 && seg[2] === 'meta' && method === 'GET') {
    return jsonResult(200, { installed_version: '1.0.0' });
  }
  if (seg.length === 3 && seg[2] === 'user' && method === 'GET') {
    return jsonResult(200, userJson());
  }

  // POST /user/repos, GET /user/repos
  if (seg.length === 4 && seg[2] === 'user' && seg[3] === 'repos') {
    if (method === 'POST') {
      const parsed = parseJsonBody(req.body);
      if (!parsed.ok) return badRequest('Problems parsing JSON');
      const name = asString(parsed.value.name);
      if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) {
        return unprocessable('name is required and must contain only letters, numbers, ".", "_" or "-"');
      }
      if (store.getRepo(name)) return unprocessable('name already exists on this account');
      const repo = store.createRepo(name, asBool(parsed.value.private, false), asString(parsed.value.description) ?? '');
      return jsonResult(201, repoJson(repo));
    }
    if (method === 'GET') {
      const repos = [...store.repos.values()].sort((a, b) => a.seq - b.seq);
      const { page, link } = paginate(repos, query, req.host, '/api/v3/user/repos');
      return withLink(jsonResult(200, page.map((r) => repoJson(r))), link);
    }
    return notFound();
  }

  // /repos/{owner}/{repo}/...
  if (seg.length >= 5 && seg[2] === 'repos') {
    const owner = seg[3];
    const repoName = seg[4];
    if (owner !== VIEWER.login) return notFound();
    const repo = store.getRepo(repoName);
    if (!repo) return notFound();
    const rest = seg.slice(5);
    return handleRepoRoute(store, repo, rest, req);
  }

  return notFound();
}

function handleRepoRoute(store: Store, repo: Repo, rest: string[], req: RestRequest): HttpResult {
  const { method, query } = req;

  // The repository itself.
  if (rest.length === 0) {
    if (method === 'GET') return jsonResult(200, repoJson(repo));
    if (method === 'PATCH') {
      const parsed = parseJsonBody(req.body);
      if (!parsed.ok) return badRequest('Problems parsing JSON');
      const desc = asString(parsed.value.description);
      if (desc !== null) repo.description = desc;
      if (typeof parsed.value.private === 'boolean') repo.private = parsed.value.private;
      const branch = asString(parsed.value.default_branch);
      if (branch) repo.defaultBranch = branch;
      repo.updatedAt = nowIso();
      return jsonResult(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.name);
      return emptyResult(204);
    }
    return notFound();
  }

  const head = rest[0];

  // ---- git refs ----
  if (head === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const parsed = parseJsonBody(req.body);
      if (!parsed.ok) return badRequest('Problems parsing JSON');
      const ref = asString(parsed.value.ref);
      const sha = asString(parsed.value.sha);
      if (!ref || !ref.startsWith('refs/')) return unprocessable('ref must start with refs/');
      if (!sha || !isHex40(sha) || !getObject(repo, sha)) return unprocessable('Invalid SHA');
      if (repo.refs.has(ref)) return unprocessable('Reference already exists');
      if (ref.startsWith('refs/heads/')) {
        const peeled = peelToCommit(repo, sha);
        if (!peeled) return unprocessable('Invalid SHA: not a commit');
        repo.refs.set(ref, peeled);
      } else {
        repo.refs.set(ref, sha);
      }
      return jsonResult(201, refJson(ref, repo.refs.get(ref)!));
    }
    if (method === 'GET' && rest.length === 2) {
      const refs = [...repo.refs.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([name, oid]) => refJson(name, oid));
      return jsonResult(200, refs);
    }
    if (method === 'GET' && rest.length > 2) {
      const refName = `refs/${rest.slice(2).join('/')}`;
      const oid = repo.refs.get(refName);
      if (!oid) return notFound();
      return jsonResult(200, refJson(refName, oid));
    }
    return notFound();
  }

  // ---- branches ----
  if (head === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const branches = [...repo.refs.entries()]
        .filter(([name]) => name.startsWith('refs/heads/'))
        .map(([name, oid]) => ({ name: name.slice('refs/heads/'.length), oid }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return jsonResult(
        200,
        branches.map((b) => ({
          name: b.name,
          commit: { sha: b.oid, url: `/api/v3/repos/${VIEWER.login}/${repo.name}/commits/${b.oid}` },
          protected: false,
        })),
      );
    }
    if (method === 'GET' && rest.length > 1) {
      const branch = rest.slice(1).join('/');
      const tip = branchTip(repo, branch);
      if (!tip) return notFound();
      return jsonResult(200, {
        name: branch,
        sha: tip,
        commit: { sha: tip, url: `/api/v3/repos/${VIEWER.login}/${repo.name}/commits/${tip}` },
        protected: false,
      });
    }
    return notFound();
  }

  // ---- commits ----
  if (head === 'commits' && method === 'GET' && rest.length === 1) {
    const ref = query.get('sha') ?? repo.defaultBranch;
    const tip = resolveRef(repo, ref);
    if (!tip) return notFound();
    const { page, perPage } = pageParams(query);
    const walked = walkCommits(repo, tip, page * perPage + 1);
    const slice = walked.slice((page - 1) * perPage, page * perPage);
    const items = slice.map((sha) => commitJson(repo, sha)).filter((c): c is Record<string, unknown> => c !== null);
    const result = jsonResult(200, items);
    if (walked.length > page * perPage) {
      const other = new URLSearchParams(query);
      other.set('page', String(page + 1));
      other.set('per_page', String(perPage));
      result.headers['link'] = `<http://${req.host}/api/v3/repos/${VIEWER.login}/${repo.name}/commits?${other.toString()}>; rel="next"`;
    }
    return result;
  }

  // ---- contents ----
  if (head === 'contents') {
    return handleContents(repo, rest.slice(1), req);
  }

  // ---- labels ----
  if (head === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      return jsonResult(200, repo.labels.map((l) => labelJson(l, repo)));
    }
    if (method === 'POST' && rest.length === 1) {
      const parsed = parseJsonBody(req.body);
      if (!parsed.ok) return badRequest('Problems parsing JSON');
      const name = asString(parsed.value.name);
      if (!name) return unprocessable('name is required');
      const existing = repo.labels.find((l) => l.name === name);
      if (existing) return jsonResult(201, labelJson(existing, repo));
      const label: Label = {
        id: store.nextLabelId(),
        name,
        color: asString(parsed.value.color) ?? 'ededed',
        description: asString(parsed.value.description) ?? '',
      };
      repo.labels.push(label);
      return jsonResult(201, labelJson(label, repo));
    }
    return notFound();
  }

  // ---- issues ----
  if (head === 'issues') {
    return handleIssues(store, repo, rest.slice(1), req);
  }

  // ---- pulls ----
  if (head === 'pulls') {
    return handlePulls(store, repo, rest.slice(1), req);
  }

  return notFound();
}

function refJson(ref: string, oid: string): Record<string, unknown> {
  return {
    ref,
    node_id: globalId('Ref', ref),
    url: `/api/v3/repos/${VIEWER.login}/git/refs/${ref.slice('refs/'.length)}`,
    object: { sha: oid, type: 'commit', url: `/api/v3/repos/${VIEWER.login}/git/commits/${oid}` },
  };
}

function handleContents(repo: Repo, pathParts: string[], req: RestRequest): HttpResult {
  const { method, query } = req;
  const path = pathParts.join('/');

  const resolveTip = (ref: string | null): string | null => {
    if (ref) return resolveRef(repo, ref);
    return branchTip(repo, repo.defaultBranch);
  };

  if (method === 'GET') {
    const tip = resolveTip(query.get('ref'));
    if (!tip) return notFound();
    const commit = getCommit(repo, tip);
    if (!commit) return notFound();
    const flat = flattenTree(repo, commit.tree);
    if (path === '') {
      return jsonResult(200, dirListing(repo, commit.tree, []));
    }
    const file = flat.get(path);
    if (file) {
      const data = getObject(repo, file.oid)?.data ?? Buffer.alloc(0);
      return jsonResult(200, fileJson(repo, path, file.oid, data));
    }
    const sub = subtreeAt(repo, commit.tree, pathParts);
    if (sub) return jsonResult(200, dirListing(repo, commit.tree, pathParts));
    return notFound();
  }

  if (method === 'PUT') {
    const parsed = parseJsonBody(req.body);
    if (!parsed.ok) return badRequest('Problems parsing JSON');
    const contentB64 = asString(parsed.value.content);
    if (contentB64 === null) return unprocessable('content is required');
    const message = asString(parsed.value.message) ?? '';
    const branch = normalizeBranch(asString(parsed.value.branch) ?? repo.defaultBranch);
    const sha = asString(parsed.value.sha);
    const data = Buffer.from(contentB64, 'base64');
    // A new branch forks from the default branch tip.
    if (!repo.refs.has(`refs/heads/${branch}`)) {
      const baseTip = branchTip(repo, repo.defaultBranch);
      if (baseTip) repo.refs.set(`refs/heads/${branch}`, baseTip);
    }
    const tip = branchTip(repo, branch);
    const flat = tip ? new Map(flattenTree(repo, getCommit(repo, tip)!.tree)) : new Map<string, { oid: string; mode: string }>();
    const current = flat.get(path);
    if (current && sha && sha !== current.oid) {
      return jsonResult(409, { message: 'The blob SHA does not match the current file' });
    }
    const isNew = !current;
    const blobOid = putObject(repo, 'blob', data);
    flat.set(path, { oid: blobOid, mode: current?.mode ?? '100644' });
    const commitSha = commitOnBranch(repo, branch, flat, message);
    repo.updatedAt = nowIso();
    return jsonResult(isNew ? 201 : 200, {
      content: fileJson(repo, path, blobOid, data),
      commit: commitJson(repo, commitSha),
    });
  }

  if (method === 'DELETE') {
    const parsed = parseJsonBody(req.body);
    if (!parsed.ok) return badRequest('Problems parsing JSON');
    const message = asString(parsed.value.message) ?? '';
    const branch = normalizeBranch(asString(parsed.value.branch) ?? repo.defaultBranch);
    const sha = asString(parsed.value.sha);
    const tip = branchTip(repo, branch);
    if (!tip) return notFound();
    const flat = new Map(flattenTree(repo, getCommit(repo, tip)!.tree));
    const current = flat.get(path);
    if (!current) return notFound();
    if (sha && sha !== current.oid) {
      return jsonResult(409, { message: 'The blob SHA does not match the current file' });
    }
    flat.delete(path);
    const commitSha = commitOnBranch(repo, branch, flat, message);
    repo.updatedAt = nowIso();
    return jsonResult(200, { content: null, commit: commitJson(repo, commitSha) });
  }

  return notFound();
}

function fileJson(repo: Repo, path: string, oid: string, data: Buffer): Record<string, unknown> {
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name,
    path,
    sha: oid,
    content: data.toString('base64'),
    url: `/api/v3/repos/${VIEWER.login}/${repo.name}/contents/${path}`,
    git_url: `/api/v3/repos/${VIEWER.login}/${repo.name}/git/blobs/${oid}`,
    html_url: `https://github.invalid/${VIEWER.login}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    download_url: null,
    _links: { git: `/api/v3/repos/${VIEWER.login}/${repo.name}/git/blobs/${oid}`, self: `/api/v3/repos/${VIEWER.login}/${repo.name}/contents/${path}`, html: `https://github.invalid/${VIEWER.login}/${repo.name}/blob/${repo.defaultBranch}/${path}` },
  };
}

function dirListing(repo: Repo, treeOid: string, parts: string[]): Array<Record<string, unknown>> {
  const sub = subtreeAt(repo, treeOid, parts);
  if (!sub || !sub.entries) return [];
  const prefix = parts.join('/');
  return sub.entries.map((e) => {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    const isDir = e.mode === '40000';
    const size = isDir ? 0 : (getObject(repo, e.oid)?.data.length ?? 0);
    return {
      type: isDir ? 'dir' : 'file',
      size,
      name: e.name,
      path,
      sha: e.oid,
      url: `/api/v3/repos/${VIEWER.login}/${repo.name}/contents/${path}`,
      git_url: `/api/v3/repos/${VIEWER.login}/${repo.name}/git/trees/${e.oid}`,
      html_url: `https://github.invalid/${VIEWER.login}/${repo.name}/${isDir ? 'tree' : 'blob'}/${repo.defaultBranch}/${path}`,
      download_url: isDir ? null : `https://github.invalid/${VIEWER.login}/${repo.name}/raw/${repo.defaultBranch}/${path}`,
      _links: {},
    };
  });
}

function handleIssues(store: Store, repo: Repo, rest: string[], req: RestRequest): HttpResult {
  const { method, query } = req;

  if (rest.length === 0) {
    if (method === 'POST') {
      const parsed = parseJsonBody(req.body);
      if (!parsed.ok) return badRequest('Problems parsing JSON');
      const title = asString(parsed.value.title);
      if (!title) return unprocessable('title is required');
      const labels = resolveIssueLabels(repo, parsed.value.labels);
      if (labels === null) return unprocessable('a label does not exist');
      const now = nowIso();
      const issue: Issue = {
        id: store.nextIssueId(),
        number: ++repo.issueSeq,
        title,
        body: asString(parsed.value.body) ?? '',
        state: 'open',
        labels,
        comments: [],
        seq: store.nextOpSeq(),
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        updatedSeq: store.nextOpSeq(),
        cachedBody: null,
      };
      repo.issues.push(issue);
      return jsonResult(201, issueJson(issue, repo));
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      if (state !== 'open' && state !== 'closed' && state !== 'all') {
        return unprocessable('state must be open, closed or all');
      }
      let items = repo.issues.filter((i) => state === 'all' || i.state === state);
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      const key = (i: Issue): number => (sort === 'updated' ? i.updatedSeq : i.seq);
      items = [...items].sort((a, b) => (direction === 'asc' ? key(a) - key(b) : key(b) - key(a)));
      const { page, link } = paginate(items, query, req.host, `/api/v3/repos/${VIEWER.login}/${repo.name}/issues`);
      return withLink(jsonResult(200, page.map((i) => issueJson(i, repo))), link);
    }
    return notFound();
  }

  const number = parseInt(rest[0], 10);
  if (!Number.isInteger(number)) return notFound();
  const issue = repo.issues.find((i) => i.number === number);
  if (!issue) return notFound();

  if (rest.length === 1) {
    if (method === 'GET') {
      // Hot path (the read workload re-reads one issue): serve the cached
      // serialization when the issue has not changed since it was built.
      if (issue.cachedBody) return bufferResult(200, issue.cachedBody, JSON_TYPE);
      const result = jsonResult(200, issueJson(issue, repo));
      issue.cachedBody = result.body;
      return result;
    }
    if (method === 'PATCH') {
      const parsed = parseJsonBody(req.body);
      if (!parsed.ok) return badRequest('Problems parsing JSON');
      const title = asString(parsed.value.title);
      if (title !== null) issue.title = title;
      const body = asString(parsed.value.body);
      if (body !== null) issue.body = body;
      const state = asString(parsed.value.state);
      if (state === 'open' || state === 'closed') {
        issue.state = state;
        issue.closedAt = state === 'closed' ? nowIso() : null;
      }
      if (parsed.value.labels !== undefined) {
        const labels = resolveIssueLabels(repo, parsed.value.labels);
        if (labels === null) return unprocessable('a label does not exist');
        issue.labels = labels;
      }
      issue.updatedAt = nowIso();
      issue.updatedSeq = store.nextOpSeq();
      invalidateIssue(issue);
      return jsonResult(200, issueJson(issue, repo));
    }
    return notFound();
  }

  if (rest[1] === 'comments') {
    if (method === 'GET') {
      const { page, link } = paginate(issue.comments, query, req.host, `/api/v3/repos/${VIEWER.login}/${repo.name}/issues/${number}/comments`);
      return withLink(jsonResult(200, page.map((c) => commentJson(c, repo, number))), link);
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(req.body);
      if (!parsed.ok) return badRequest('Problems parsing JSON');
      const body = asString(parsed.value.body);
      if (!body) return unprocessable('body is required');
      const now = nowIso();
      const comment: Comment = { id: store.nextCommentId(), body, createdAt: now, updatedAt: now };
      issue.comments.push(comment);
      issue.updatedAt = now;
      issue.updatedSeq = store.nextOpSeq();
      invalidateIssue(issue);
      return jsonResult(201, commentJson(comment, repo, number));
    }
  }

  return notFound();
}

function resolveIssueLabels(repo: Repo, raw: unknown): Label[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const out: Label[] = [];
  for (const item of raw) {
    const name = typeof item === 'string' ? item : (item as Record<string, unknown>)?.name;
    if (typeof name !== 'string') return null;
    const found = repo.labels.find((l) => l.name === name);
    if (!found) return null;
    out.push(found);
  }
  return out;
}

function handlePulls(store: Store, repo: Repo, rest: string[], req: RestRequest): HttpResult {
  const { method, query } = req;

  if (rest.length === 0) {
    if (method === 'POST') {
      const created = createPull(store, repo, req.body);
      if ('error' in created) return created.error;
      return jsonResult(201, pullJson(created.pull, repo));
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      if (state !== 'open' && state !== 'closed' && state !== 'all') {
        return unprocessable('state must be open, closed or all');
      }
      let items = repo.pulls.filter((p) => state === 'all' || p.state === state);
      const direction = query.get('direction') ?? 'desc';
      items = [...items].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      const { page, link } = paginate(items, query, req.host, `/api/v3/repos/${VIEWER.login}/${repo.name}/pulls`);
      return withLink(jsonResult(200, page.map((p) => pullJson(p, repo))), link);
    }
    return notFound();
  }

  const number = parseInt(rest[0], 10);
  if (!Number.isInteger(number)) return notFound();
  const pull = repo.pulls.find((p) => p.number === number);
  if (!pull) return notFound();

  if (rest.length === 1) {
    if (method === 'GET') return jsonResult(200, pullJson(pull, repo));
    return notFound();
  }

  if (rest[1] === 'files' && method === 'GET') {
    const files = pullFiles(repo, pull);
    if (!files) return notFound();
    return jsonResult(200, files);
  }

  if (rest[1] === 'merge' && (method === 'PUT' || method === 'POST')) {
    const parsed = parseJsonBody(req.body);
    if (!parsed.ok) return badRequest('Problems parsing JSON');
    const merged = mergePull(repo, pull, asString(parsed.value.commit_title));
    if ('error' in merged) return merged.error;
    return jsonResult(200, { sha: merged.sha, merged: true, message: 'Pull Request successfully merged' });
  }

  return notFound();
}

export function createPull(
  store: Store,
  repo: Repo,
  body: Buffer,
): { pull: Pull } | { error: HttpResult } {
  const parsed = parseJsonBody(body);
  if (!parsed.ok) return { error: badRequest('Problems parsing JSON') };
  return createPullFromFields(store, repo, {
    title: asString(parsed.value.title),
    body: asString(parsed.value.body),
    head: asString(parsed.value.head),
    base: asString(parsed.value.base),
  });
}

export function createPullFromFields(
  store: Store,
  repo: Repo,
  fields: { title: string | null; body: string | null; head: string | null; base: string | null },
): { pull: Pull } | { error: HttpResult } {
  if (!fields.title) return { error: unprocessable('title is required') };
  if (!fields.head) return { error: unprocessable('head is required') };
  if (!fields.base) return { error: unprocessable('base is required') };
  const headRef = normalizeBranch(fields.head);
  const baseRef = normalizeBranch(fields.base);
  const headTip = branchTip(repo, headRef);
  const baseTip = branchTip(repo, baseRef);
  if (!headTip) return { error: unprocessable(`head branch ${headRef} does not exist`) };
  if (!baseTip) return { error: unprocessable(`base branch ${baseRef} does not exist`) };
  const dupe = repo.pulls.find((p) => p.state === 'open' && p.headRef === headRef && p.baseRef === baseRef);
  if (dupe) return { error: unprocessable('A pull request already exists for this head and base') };
  const now = nowIso();
  const pull: Pull = {
    id: store.nextPullId(),
    number: ++repo.pullSeq,
    title: fields.title,
    body: fields.body ?? '',
    state: 'open',
    headRef,
    baseRef,
    headSha: headTip,
    baseSha: baseTip,
    merged: false,
    mergeCommitSha: null,
    mergedAt: null,
    seq: store.nextOpSeq(),
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
  repo.pulls.push(pull);
  return { pull };
}

/** The changed files of a pull request: merge-base tree vs head tip tree. */
export function pullFiles(repo: Repo, pull: Pull): Array<Record<string, unknown>> | null {
  const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseTip = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  const headCommit = getCommit(repo, headTip);
  if (!headCommit) return null;
  const mb = mergeBase(repo, baseTip, headTip);
  const baseFlat = mb && getCommit(repo, mb) ? flattenTree(repo, getCommit(repo, mb)!.tree) : new Map();
  const headFlat = flattenTree(repo, headCommit.tree);
  const diffs = diffFlats(repo, baseFlat, headFlat);
  return diffs.map((d) => {
    const blobOid = d.status === 'removed' ? baseFlat.get(d.path)?.oid : headFlat.get(d.path)?.oid;
    return {
      sha: blobOid ?? '',
      filename: d.path,
      status: d.status,
      additions: d.additions,
      deletions: d.deletions,
      changes: d.additions + d.deletions,
      blob_url: `https://github.invalid/${VIEWER.login}/${repo.name}/blob/${headTip}/${d.path}`,
      raw_url: `https://github.invalid/${VIEWER.login}/${repo.name}/raw/${headTip}/${d.path}`,
      contents_url: `/api/v3/repos/${VIEWER.login}/${repo.name}/contents/${d.path}?ref=${headTip}`,
    };
  });
}

export function mergePull(
  repo: Repo,
  pull: Pull,
  commitTitle: string | null,
): { sha: string } | { error: HttpResult } {
  if (pull.merged) return { error: jsonResult(405, { message: 'Pull request has already been merged' }) };
  if (pull.state === 'closed') return { error: jsonResult(405, { message: 'Pull request is closed' }) };
  const baseTip = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
  const merged = squashMergeTree(repo, baseTip, headTip);
  if (merged === null) {
    return { error: jsonResult(405, { message: 'Merge conflict: the head branch has changes that conflict with the base branch' }) };
  }
  const message = commitTitle ?? `Merge pull request #${pull.number} from ${VIEWER.login}/${pull.headRef}\n\n${pull.title}`;
  const sha = commitWithParent(repo, merged, baseTip, message);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  const now = nowIso();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.mergedAt = now;
  pull.closedAt = now;
  pull.updatedAt = now;
  pull.baseSha = sha;
  repo.updatedAt = now;
  return { sha };
}

/** Mergeability for GraphQL: MERGEABLE / CONFLICTING / UNKNOWN. */
export function pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.merged || pull.state === 'closed') return 'UNKNOWN';
  const baseTip = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
  if (!getCommit(repo, baseTip) || !getCommit(repo, headTip)) return 'UNKNOWN';
  return squashMergeTree(repo, baseTip, headTip) === null ? 'CONFLICTING' : 'MERGEABLE';
}
