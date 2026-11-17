// Git smart HTTP: info/refs advertisements (protocol v0 and v2), upload-pack
// (ls-refs and fetch in v2, want/have fetch in v0) and receive-pack. The
// object store is the repo's own; pushed objects are stored verbatim and
// immediately visible to REST, GraphQL and MCP.

import {
  branchTip,
  getCommit,
  getObject,
  getTag,
  getTree,
  headRefName,
  isAncestor,
  peelToCommit,
  peelToNonTag,
  putObject,
  ZERO_OID,
  type Repo,
} from './store.ts';
import { decodeAllPkts, decodePkts, PKT_FLUSH, pkt, pktText, readPack, sideband, writePack, type Pkt } from './pack.ts';
import { bufferResult, textResult, type HttpResult } from './respond.ts';

const AGENT = 'agent=forge/1.0';

const UPLOAD_ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_ADVERTISEMENT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

// ---------------------------------------------------------------------------
// Advertisements
// ---------------------------------------------------------------------------

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Peeled commit oid for a ref pointing at an annotated tag, else null. */
function peeledOid(repo: Repo, oid: string): string | null {
  const obj = getObject(repo, oid);
  if (!obj || obj.type !== 'tag') return null;
  const peeled = peelToNonTag(repo, oid);
  if (!peeled || peeled === oid) return null;
  return peeled;
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [pkt(`# service=${service}\n`), PKT_FLUSH];
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:${headRefName(repo)} side-band-64k thin-pack ofs-delta multi_ack_detailed shallow ${AGENT}`
      : `report-status delete-refs side-band-64k ofs-delta ${AGENT} symref=HEAD:${headRefName(repo)}`;
  const refs = sortedRefs(repo);
  const tip = branchTip(repo, repo.defaultBranch);
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pkt(`${tip ?? ZERO_OID} HEAD\0${caps}\n`));
    for (const [name, oid] of refs) {
      parts.push(pkt(`${oid} ${name}\n`));
      const peeled = peeledOid(repo, oid);
      if (peeled) parts.push(pkt(`${peeled} ${name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return V2_ADVERTISEMENT;
}

// The v2 advertisement never changes: build it once.
const V2_ADVERTISEMENT: Buffer = Buffer.concat([
  pkt('# service=git-upload-pack\n'),
  PKT_FLUSH,
  pkt('version 2\n'),
  pkt('fetch=shallow\n'),
  pkt('ls-refs=unborn\n'),
  pkt('object-format=sha1\n'),
  pkt(`${AGENT}\n`),
  PKT_FLUSH,
]);

export function handleInfoRefs(repo: Repo, service: string, wantsV2: boolean): HttpResult {
  if (service === 'git-upload-pack') {
    if (wantsV2) return bufferResult(200, v2Advertisement(), UPLOAD_ADVERTISEMENT);
    return bufferResult(200, v0Advertisement(repo, 'git-upload-pack'), UPLOAD_ADVERTISEMENT);
  }
  if (service === 'git-receive-pack') {
    return bufferResult(200, v0Advertisement(repo, 'git-receive-pack'), RECEIVE_ADVERTISEMENT);
  }
  return textResult(400, 'unknown service');
}

// ---------------------------------------------------------------------------
// Object closure for fetch
// ---------------------------------------------------------------------------

interface Closure {
  objects: Set<string>;
  boundary: Set<string>;
}

function addTreeClosure(repo: Repo, treeOid: string, into: Set<string>): void {
  const stack = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (into.has(oid)) continue;
    const entries = getTree(repo, oid);
    if (!entries) continue;
    into.add(oid);
    for (const e of entries) {
      if (e.mode === '40000') stack.push(e.oid);
      else if (e.mode === '160000') continue;
      else into.add(e.oid);
    }
  }
}

/**
 * Collect the objects reachable from `roots`. Tag objects are peeled (every
 * tag in the chain is included). Commit traversal is generation-limited by
 * `maxDepth` (null = unlimited); commits in `stopAt` are included with their
 * trees but their parents are not followed. `boundary` holds the included
 * commits whose parents were cut by the depth limit.
 */
function collectClosure(
  repo: Repo,
  roots: string[],
  maxDepth: number | null,
  stopAt: Set<string>,
): Closure {
  const objects = new Set<string>();
  const boundary = new Set<string>();
  const generations = new Map<string, number>();
  const queue: string[] = [];

  const enqueueCommit = (oid: string, gen: number): void => {
    const prev = generations.get(oid);
    if (prev !== undefined && prev <= gen) return;
    generations.set(oid, gen);
    queue.push(oid);
  };

  for (const root of roots) {
    let cur = root;
    const seenTags = new Set<string>();
    for (;;) {
      const obj = getObject(repo, cur);
      if (!obj) break;
      if (obj.type === 'tag') {
        if (seenTags.has(cur)) break;
        seenTags.add(cur);
        objects.add(cur);
        const tag = getTag(repo, cur);
        if (!tag) break;
        cur = tag.object;
        continue;
      }
      if (obj.type === 'commit') enqueueCommit(cur, 0);
      else if (obj.type === 'tree') addTreeClosure(repo, cur, objects);
      else objects.add(cur);
      break;
    }
  }

  // BFS by generation so boundary detection is by shortest distance.
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head++];
    const gen = generations.get(oid)!;
    if (maxDepth !== null && gen >= maxDepth) continue;
    if (objects.has(oid)) continue;
    const commit = getCommit(repo, oid);
    if (!commit) continue;
    objects.add(oid);
    addTreeClosure(repo, commit.tree, objects);
    if (stopAt.has(oid)) continue;
    if (maxDepth !== null && gen === maxDepth - 1) {
      if (commit.parents.length > 0) boundary.add(oid);
      continue;
    }
    for (const p of commit.parents) enqueueCommit(p, gen + 1);
  }
  return { objects, boundary };
}

interface FetchPlan {
  wants: string[];
  haves: string[];
  shallows: string[];
  depth: number | null;
}

function planFetch(repo: Repo, plan: FetchPlan): { pack: Buffer; shallowOut: string[]; unshallowOut: string[] } {
  const shallowSet = new Set(plan.shallows);
  const held = collectClosure(repo, plan.haves, null, shallowSet);
  const wanted = collectClosure(repo, plan.wants, plan.depth, new Set());
  const send: string[] = [];
  for (const oid of wanted.objects) if (!held.objects.has(oid)) send.push(oid);
  const shallowOut = plan.depth === null ? [] : [...wanted.boundary].sort();
  const unshallowOut: string[] = [];
  if (plan.depth !== null) {
    for (const oid of shallowSet) {
      if (wanted.objects.has(oid) && !wanted.boundary.has(oid) && getCommit(repo, oid)) {
        unshallowOut.push(oid);
      }
    }
    unshallowOut.sort();
  }
  const objs = send
    .map((oid) => {
      const obj = getObject(repo, oid);
      return obj ? { oid, type: obj.type, data: obj.data } : null;
    })
    .filter((o): o is { oid: string; type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer } => o !== null);
  return { pack: writePack(objs), shallowOut, unshallowOut };
}

// ---------------------------------------------------------------------------
// Protocol v2: ls-refs and fetch
// ---------------------------------------------------------------------------

interface V2Command {
  command: string;
  args: string[];
}

function parseV2(body: Buffer): V2Command | null {
  const packets = decodeAllPkts(body);
  let command = '';
  const args: string[] = [];
  let pastDelim = false;
  for (const p of packets) {
    if (p.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (p.kind !== 'data') continue;
    const text = pktText(p.data);
    if (command === '') {
      if (!text.startsWith('command=')) return null;
      command = text.slice('command='.length);
      continue;
    }
    if (pastDelim) args.push(text);
  }
  if (command === '') return null;
  return { command, args };
}

function handleLsRefs(repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const tip = branchTip(repo, repo.defaultBranch);
  if (symrefs && matches('HEAD')) {
    if (tip) parts.push(pkt(`${tip} HEAD symref-target:${headRefName(repo)}\n`));
    else if (unborn) parts.push(pkt(`unborn HEAD symref-target:${headRefName(repo)}\n`));
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const peeled = peeledOid(repo, oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    parts.push(pkt(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function handleFetchV2(repo: Repo, args: string[]): Buffer {
  const plan: FetchPlan = { wants: [], haves: [], shallows: [], depth: null };
  for (const arg of args) {
    if (arg.startsWith('want ')) plan.wants.push(arg.slice(5).split(' ')[0]);
    else if (arg.startsWith('have ')) plan.haves.push(arg.slice(5));
    else if (arg.startsWith('shallow ')) plan.shallows.push(arg.slice(8));
    else if (arg.startsWith('deepen ')) {
      const n = parseInt(arg.slice(7), 10);
      if (Number.isFinite(n) && n > 0) plan.depth = n;
    }
    // thin-pack, no-progress, ofs-delta, filter, done: accepted, no action.
  }
  const { pack, shallowOut, unshallowOut } = planFetch(repo, plan);
  const parts: Buffer[] = [pkt('acknowledgments\n'), pkt('NAK\n'), PKT_FLUSH];
  if (shallowOut.length > 0 || unshallowOut.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of shallowOut) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of unshallowOut) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pkt('packfile\n'), ...sideband(1, pack), PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Protocol v0 fetch (want/have)
// ---------------------------------------------------------------------------

function handleFetchV0(repo: Repo, body: Buffer): Buffer {
  const packets = decodeAllPkts(body);
  const plan: FetchPlan = { wants: [], haves: [], shallows: [], depth: null };
  let sawWant = false;
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const text = pktText(p.data);
    if (text.startsWith('want ')) {
      sawWant = true;
      plan.wants.push(text.slice(5).split(' ')[0]);
    } else if (text.startsWith('have ')) plan.haves.push(text.slice(5));
    else if (text.startsWith('shallow ')) plan.shallows.push(text.slice(8));
    else if (text.startsWith('deepen ')) {
      const n = parseInt(text.slice(7), 10);
      if (Number.isFinite(n) && n > 0) plan.depth = n;
    }
  }
  if (!sawWant) return Buffer.alloc(0);
  const { pack, shallowOut, unshallowOut } = planFetch(repo, plan);
  const parts: Buffer[] = [pkt('NAK\n')];
  for (const oid of shallowOut) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of unshallowOut) parts.push(pkt(`unshallow ${oid}\n`));
  parts.push(...sideband(1, pack), PKT_FLUSH);
  return Buffer.concat(parts);
}

export function handleUploadPack(repo: Repo, body: Buffer, wantsV2: boolean): HttpResult {
  if (wantsV2) {
    const parsed = parseV2(body);
    if (!parsed) return textResult(400, 'bad request');
    if (parsed.command === 'ls-refs') {
      return bufferResult(200, handleLsRefs(repo, parsed.args), UPLOAD_RESULT);
    }
    if (parsed.command === 'fetch') {
      return bufferResult(200, handleFetchV2(repo, parsed.args), UPLOAD_RESULT);
    }
    return bufferResult(200, Buffer.concat([pkt(`ERR unknown command ${parsed.command}\n`), PKT_FLUSH]), UPLOAD_RESULT);
  }
  const out = handleFetchV0(repo, body);
  if (out.length === 0) return textResult(400, 'bad request');
  return bufferResult(200, out, UPLOAD_RESULT);
}

// ---------------------------------------------------------------------------
// Receive-pack
// ---------------------------------------------------------------------------

function validRefName(ref: string): boolean {
  if (!ref.startsWith('refs/')) return false;
  if (ref.includes('..') || ref.includes('//') || ref.endsWith('/') || ref.endsWith('.') || ref.endsWith('.lock')) return false;
  if (ref.includes('@{')) return false;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f || c === 0x20 || c === 0x7e || c === 0x5e || c === 0x3a || c === 0x3f || c === 0x2a || c === 0x5b) {
      return false;
    }
  }
  return true;
}

interface RefUpdate {
  oldOid: string;
  newOid: string;
  ref: string;
}

function applyRefUpdate(repo: Repo, update: RefUpdate): { ok: boolean; reason: string } {
  const { oldOid, newOid, ref } = update;
  if (!validRefName(ref)) return { ok: false, reason: 'invalid refname' };
  const current = repo.refs.get(ref);
  if (newOid === ZERO_OID) {
    // Delete.
    if (!current) return { ok: false, reason: 'remote ref does not exist' };
    if (oldOid !== current) return { ok: false, reason: 'old oid mismatch' };
    repo.refs.delete(ref);
    return { ok: true, reason: '' };
  }
  const target = getObject(repo, newOid);
  if (!target) return { ok: false, reason: 'object not found' };
  if (oldOid === ZERO_OID) {
    // Create.
    if (current) return { ok: false, reason: 'already exists' };
    if (ref.startsWith('refs/heads/') && target.type !== 'commit') {
      return { ok: false, reason: 'not a commit' };
    }
    repo.refs.set(ref, newOid);
    return { ok: true, reason: '' };
  }
  // Update.
  if (!current) return { ok: false, reason: 'remote ref does not exist' };
  if (oldOid !== current) return { ok: false, reason: 'old oid mismatch' };
  if (newOid === oldOid) return { ok: true, reason: '' };
  if (ref.startsWith('refs/heads/') && target.type !== 'commit') {
    return { ok: false, reason: 'not a commit' };
  }
  const oldCommit = peelToCommit(repo, oldOid);
  const newCommit = peelToCommit(repo, newOid);
  if (oldCommit && newCommit) {
    if (isAncestor(repo, oldCommit, newCommit)) {
      repo.refs.set(ref, newOid);
      return { ok: true, reason: '' };
    }
    return { ok: false, reason: 'non-fast-forward' };
  }
  return { ok: false, reason: 'non-fast-forward' };
}

export function handleReceivePack(repo: Repo, body: Buffer): HttpResult {
  const { packets, consumed } = decodePkts(body, true);
  const dataLines: Buffer[] = [];
  for (const p of packets) {
    if (p.kind === 'data') dataLines.push(p.data);
  }
  if (dataLines.length === 0) return textResult(400, 'bad request');

  let clientCaps = '';
  const updates: RefUpdate[] = [];
  dataLines.forEach((lineBuf, i) => {
    let text = pktText(lineBuf);
    if (i === 0) {
      const nul = text.indexOf('\0');
      if (nul !== -1) {
        clientCaps = text.slice(nul + 1);
        text = text.slice(0, nul);
      }
    }
    const parts = text.split(' ');
    if (parts.length >= 3) {
      updates.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
    }
  });

  // Unpack: store every object in the pack before touching any ref.
  let unpackError: string | null = null;
  const packBytes = body.subarray(consumed);
  if (packBytes.length > 0) {
    try {
      const entries = readPack(packBytes, repo);
      for (const e of entries) putObject(repo, e.type, e.data);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  const reportLines: string[] = [];
  if (unpackError) {
    reportLines.push(`unpack ${unpackError}\n`);
    for (const u of updates) reportLines.push(`ng ${u.ref} unpack error\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const u of updates) {
      const result = applyRefUpdate(repo, u);
      reportLines.push(result.ok ? `ok ${u.ref}\n` : `ng ${u.ref} ${result.reason}\n`);
    }
  }
  const report = Buffer.concat(reportLines.map((line) => pkt(line)));
  const useSideband = clientCaps.split(' ').includes('side-band-64k');
  const out = useSideband
    ? Buffer.concat([...sideband(1, report), PKT_FLUSH])
    : Buffer.concat([report, PKT_FLUSH]);
  return bufferResult(200, out, RECEIVE_RESULT);
}
