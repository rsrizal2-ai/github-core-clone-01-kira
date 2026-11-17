// In-memory forge state: one git object store per repository, plus the
// REST/GraphQL/MCP resources (issues, pull requests, labels, comments) that
// all read and write the same store. A trial is one process and one owner, so
// nothing here is persisted; everything lives in Maps, keyed deterministically.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';

/** The identity the token names. The trial scenario is fixed, so the viewer is fixed. */
export const VIEWER = {
  id: 1000,
  login: process.env.MAKEFUN_VIEWER_LOGIN ?? 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string; // '100644' | '100755' | '120000' | '40000' | '160000'
  name: string;
  oid: string;
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface ParsedTag {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  seq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  updatedSeq: number;
  /** Serialized GET-issue response, cleared by every mutation of the issue. */
  cachedBody: Buffer | null;
}

/** Drop an issue's cached GET response; call on every mutation of the issue. */
export function invalidateIssue(issue: Issue): void {
  issue.cachedBody = null;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  seq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Repo {
  id: number;
  name: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  commitCache: Map<string, ParsedCommit>;
  tagCache: Map<string, ParsedTag>;
  treeCache: Map<string, TreeEntry[]>;
  flatCache: Map<string, Map<string, { oid: string; mode: string }>>;
  issues: Issue[];
  pulls: Pull[];
  labels: Label[];
  issueSeq: number;
  pullSeq: number;
  commentSeq: number;
  labelSeq: number;
}

/** SHA-1 of a git object header plus its bytes: the object's identity. */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function isHex40(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}

/** Parse a commit object's headers. Extra headers are ignored, never rebuilt. */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const headerPart = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerPart.split('\n')) {
    if (line.startsWith(' ')) continue; // continuation of a multi-line header
    const sp = line.indexOf(' ');
    if (sp === -1) continue;
    const key = line.slice(0, sp);
    const value = line.slice(sp + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const headerPart = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  let object = '';
  let type: ObjType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of headerPart.split('\n')) {
    if (line.startsWith(' ')) continue;
    const sp = line.indexOf(' ');
    if (sp === -1) continue;
    const key = line.slice(0, sp);
    const value = line.slice(sp + 1);
    if (key === 'object') object = value;
    else if (key === 'type') type = value as ObjType;
    else if (key === 'tag') tag = value;
    else if (key === 'tagger') tagger = value;
  }
  return { object, type, tag, tagger, message };
}

/** Parse a tree object's binary entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp === -1) break;
    const mode = data.subarray(off, sp).toString('ascii');
    const nul = data.indexOf(0x00, sp + 1);
    if (nul === -1) break;
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

/** Git's tree sort: entries compare by name, directories with a trailing '/'. */
export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  if (an < bn) return -1;
  if (an > bn) return 1;
  return 0;
}

/** Serialize tree entries in git order. */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Build a commit object. The message is stored verbatim, byte for byte. */
export function buildCommitObject(
  tree: string,
  parents: string[],
  authorLine: string,
  committerLine: string,
  message: string,
): Buffer {
  let head = `tree ${tree}\n`;
  for (const p of parents) head += `parent ${p}\n`;
  head += `author ${authorLine}\ncommitter ${committerLine}\n\n`;
  return Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from(message, 'utf8')]);
}

/** The viewer as a git identity line, at the given unix time. */
export function identityLine(whenSec: number): string {
  return `${VIEWER.name} <${VIEWER.email}> ${whenSec} +0000`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Global ids are opaque: base64 of a typed key, never the bare database id. */
export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const idx = text.indexOf(':');
    if (idx <= 0) return null;
    return { kind: text.slice(0, idx), key: text.slice(idx + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class Store {
  repos = new Map<string, Repo>();
  private repoIdSeq = 1;
  private repoSeq = 1;
  private issueIdSeq = 1;
  private pullIdSeq = 1;
  private commentIdSeq = 1;
  private labelIdSeq = 1;
  private opSeq = 1;

  nextOpSeq(): number {
    return this.opSeq++;
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    const now = nowIso();
    const repo: Repo = {
      id: this.repoIdSeq++,
      name,
      private: isPrivate,
      description,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      seq: this.repoSeq++,
      objects: new Map(),
      refs: new Map(),
      commitCache: new Map(),
      tagCache: new Map(),
      treeCache: new Map(),
      flatCache: new Map(),
      issues: [],
      pulls: [],
      labels: [],
      issueSeq: 0,
      pullSeq: 0,
      commentSeq: 0,
      labelSeq: 0,
    };
    this.repos.set(name, repo);
    return repo;
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  nextIssueId(): number {
    return this.issueIdSeq++;
  }

  nextPullId(): number {
    return this.pullIdSeq++;
  }

  nextCommentId(): number {
    return this.commentIdSeq++;
  }

  nextLabelId(): number {
    return this.labelIdSeq++;
  }
}

// ---------------------------------------------------------------------------
// Object access helpers (per repo)
// ---------------------------------------------------------------------------

export function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

export function getCommit(repo: Repo, oid: string): ParsedCommit | null {
  const cached = repo.commitCache.get(oid);
  if (cached) return cached;
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'commit') return null;
  const parsed = parseCommit(obj.data);
  repo.commitCache.set(oid, parsed);
  return parsed;
}

export function getTag(repo: Repo, oid: string): ParsedTag | null {
  const cached = repo.tagCache.get(oid);
  if (cached) return cached;
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return null;
  const parsed = parseTag(obj.data);
  repo.tagCache.set(oid, parsed);
  return parsed;
}

export function getTree(repo: Repo, oid: string): TreeEntry[] | null {
  const cached = repo.treeCache.get(oid);
  if (cached) return cached;
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tree') return null;
  const parsed = parseTree(obj.data);
  repo.treeCache.set(oid, parsed);
  return parsed;
}

/** Follow tag objects until a non-tag object. Returns the peeled oid, or null. */
export function peelToNonTag(repo: Repo, oid: string): string | null {
  let cur = oid;
  const seen = new Set<string>();
  for (let i = 0; i < 64; i++) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (!obj) return null;
    if (obj.type !== 'tag') return cur;
    const tag = getTag(repo, cur);
    if (!tag) return null;
    cur = tag.object;
  }
  return null;
}

/** Peel to a commit oid, or null when the chain does not end at a commit. */
export function peelToCommit(repo: Repo, oid: string): string | null {
  const peeled = peelToNonTag(repo, oid);
  if (!peeled) return null;
  const obj = repo.objects.get(peeled);
  return obj && obj.type === 'commit' ? peeled : null;
}

/** Flatten a tree to path -> {oid, mode}, skipping gitlinks. Cached per tree. */
export function flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
  const cached = repo.flatCache.get(treeOid);
  if (cached) return cached;
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const entries = getTree(repo, oid);
    if (!entries) return;
    for (const e of entries) {
      const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.mode === '40000') walk(e.oid, path);
      else if (e.mode === '160000') continue;
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
  };
  walk(treeOid, '');
  repo.flatCache.set(treeOid, out);
  return out;
}

/** Build nested trees from a flat path map; returns the root tree oid. */
export function treeFromFlat(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    entries: Map<string, TreeEntry>;
    dirs: Map<string, Node>;
  }
  const root: Node = { entries: new Map(), dirs: new Map() };
  for (const [path, v] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = node.dirs.get(parts[i]);
      if (!next) {
        next = { entries: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], next);
      }
      node = next;
    }
    node.entries.set(parts[parts.length - 1], { mode: v.mode, name: parts[parts.length - 1], oid: v.oid });
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [...node.entries.values()];
    for (const [name, child] of node.dirs) {
      entries.push({ mode: '40000', name, oid: build(child) });
    }
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** Is `ancestor` reachable from `oid` by following parents? (oid itself counts.) */
export function isAncestor(repo: Repo, ancestor: string, oid: string): boolean {
  if (ancestor === oid) return true;
  const seen = new Set<string>();
  const stack = [oid];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const commit = getCommit(repo, cur);
    if (!commit) continue;
    for (const p of commit.parents) {
      if (p === ancestor) return true;
      stack.push(p);
    }
  }
  return false;
}

/** First common ancestor of two commits (BFS from both sides), or null. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const fromA = new Set<string>();
  const stackA = [a];
  while (stackA.length > 0) {
    const cur = stackA.pop()!;
    if (fromA.has(cur)) continue;
    fromA.add(cur);
    const commit = getCommit(repo, cur);
    if (commit) for (const p of commit.parents) stackA.push(p);
  }
  const seenB = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (seenB.has(cur)) continue;
    seenB.add(cur);
    if (fromA.has(cur)) return cur;
    const commit = getCommit(repo, cur);
    if (commit) for (const p of commit.parents) queue.push(p);
  }
  return null;
}

/** Walk commits from a tip, newest first, parents after the commit. */
export function walkCommits(repo: Repo, tip: string, limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0 && out.length < limit) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const commit = getCommit(repo, cur);
    if (!commit) continue;
    out.push(cur);
    // Push parents in reverse so the first parent is visited first.
    for (let i = commit.parents.length - 1; i >= 0; i--) stack.push(commit.parents[i]);
  }
  return out;
}

/** Resolve a ref-ish: branch name, full ref, tag name, or raw commit oid. */
export function resolveRef(repo: Repo, ref: string): string | null {
  if (repo.refs.has(ref)) return repo.refs.get(ref)!;
  const head = `refs/heads/${ref}`;
  if (repo.refs.has(head)) return repo.refs.get(head)!;
  const tag = `refs/tags/${ref}`;
  if (repo.refs.has(tag)) return peelToCommit(repo, repo.refs.get(tag)!) ?? repo.refs.get(tag)!;
  if (isHex40(ref)) {
    const obj = repo.objects.get(ref);
    if (obj && obj.type === 'commit') return ref;
    if (obj && obj.type === 'tag') return peelToCommit(repo, ref);
  }
  if (ref === 'HEAD') {
    const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    return tip ?? null;
  }
  return null;
}

/** The tip commit of a branch, or null when the branch does not exist. */
export function branchTip(repo: Repo, branch: string): string | null {
  const oid = repo.refs.get(`refs/heads/${branch}`);
  if (!oid) return null;
  return peelToCommit(repo, oid) ?? oid;
}

export function headRefName(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** Count lines in a blob for diff stats (a trailing newline ends, not adds, a line). */
export function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < data.length; i++) if (data[i] === 0x0a) n++;
  if (data[data.length - 1] !== 0x0a) n++;
  return n;
}

export interface DiffEntry {
  path: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
}

/** Diff two flattened trees. Line counts are per-file totals, not hunks. */
export function diffFlats(
  repo: Repo,
  base: Map<string, { oid: string; mode: string }>,
  head: Map<string, { oid: string; mode: string }>,
): DiffEntry[] {
  const out: DiffEntry[] = [];
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) {
      const data = repo.objects.get(b.oid)?.data ?? Buffer.alloc(0);
      out.push({ path, status: 'removed', additions: 0, deletions: countLines(data) });
    } else if (!b && h) {
      const data = repo.objects.get(h.oid)?.data ?? Buffer.alloc(0);
      out.push({ path, status: 'added', additions: countLines(data), deletions: 0 });
    } else if (b && h && (b.oid !== h.oid || b.mode !== h.mode)) {
      const bd = repo.objects.get(b.oid)?.data ?? Buffer.alloc(0);
      const hd = repo.objects.get(h.oid)?.data ?? Buffer.alloc(0);
      out.push({ path, status: 'modified', additions: countLines(hd), deletions: countLines(bd) });
    }
  }
  return out;
}

/**
 * Squash-merge analysis between a base tip and a head tip. Returns the
 * merged flat tree, or null when the same path changed differently on both
 * sides relative to the merge base (a conflict).
 */
export function squashMergeTree(
  repo: Repo,
  baseTip: string,
  headTip: string,
): Map<string, { oid: string; mode: string }> | null {
  const baseCommit = getCommit(repo, baseTip);
  const headCommit = getCommit(repo, headTip);
  if (!baseCommit || !headCommit) return null;
  const baseFlat = flattenTree(repo, baseCommit.tree);
  const headFlat = flattenTree(repo, headCommit.tree);
  const mb = mergeBase(repo, baseTip, headTip);
  const mbFlat = mb ? flattenTree(repo, getCommit(repo, mb)!.tree) : new Map<string, { oid: string; mode: string }>();
  const merged = new Map(baseFlat);
  const paths = new Set<string>([...mbFlat.keys(), ...headFlat.keys(), ...baseFlat.keys()]);
  for (const path of paths) {
    const m = mbFlat.get(path);
    const b = baseFlat.get(path);
    const h = headFlat.get(path);
    const baseChanged = JSON.stringify(b ?? null) !== JSON.stringify(m ?? null);
    const headChanged = JSON.stringify(h ?? null) !== JSON.stringify(m ?? null);
    if (!headChanged) continue;
    if (baseChanged && JSON.stringify(b ?? null) !== JSON.stringify(h ?? null)) return null;
    if (h) merged.set(path, h);
    else merged.delete(path);
  }
  return merged;
}

/** Create a commit on a branch from a flat tree, advancing the branch ref. */
export function commitOnBranch(
  repo: Repo,
  branch: string,
  flat: Map<string, { oid: string; mode: string }>,
  message: string,
): string {
  const treeOid = treeFromFlat(repo, flat);
  const parent = branchTip(repo, branch);
  const parents = parent ? [parent] : [];
  const when = Math.floor(Date.now() / 1000);
  const line = identityLine(when);
  const oid = putObject(repo, 'commit', buildCommitObject(treeOid, parents, line, line, message));
  repo.refs.set(`refs/heads/${branch}`, oid);
  return oid;
}

/** Create a commit whose parent is an explicit tip (used by squash merges). */
export function commitWithParent(
  repo: Repo,
  flat: Map<string, { oid: string; mode: string }>,
  parent: string | null,
  message: string,
): string {
  const treeOid = treeFromFlat(repo, flat);
  const when = Math.floor(Date.now() / 1000);
  const line = identityLine(when);
  return putObject(repo, 'commit', buildCommitObject(treeOid, parent ? [parent] : [], line, line, message));
}
