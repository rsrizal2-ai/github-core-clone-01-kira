// GraphQL v4: a small parser and executor covering the query and mutation
// documents the suite sends — variables, aliases, fragments, inline input
// objects and enums — plus __type introspection and unknown-field errors.
// It shares the Store with REST, git and MCP.

import {
  branchTip,
  decodeGlobalId,
  getCommit,
  globalId,
  invalidateIssue,
  nowIso,
  VIEWER,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { createPullFromFields, mergePull, pullFiles, pullMergeable } from './rest.ts';
import { badRequest, jsonResult, type HttpResult } from './respond.ts';

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'ellipsis' | 'eof';
  value: string;
}

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < input.length) {
    const c = input[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i++;
      continue;
    }
    if (c === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'ellipsis', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'b') out += '\b';
          else if (esc === 'f') out += '\f';
          else if (esc === 'u') {
            out += String.fromCharCode(parseInt(input.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += input[j];
          j++;
        }
      }
      if (j >= input.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      if (input[j] === '-') j++;
      while (j < input.length && /[0-9]/.test(input[j])) j++;
      let isFloat = false;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] ?? '')) {
        isFloat = true;
        j++;
        while (j < input.length && /[0-9]/.test(input[j])) j++;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j++;
        if (input[j] === '+' || input[j] === '-') j++;
        while (j < input.length && /[0-9]/.test(input[j])) j++;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i + 1;
      while (j < input.length && isNameChar(input[j])) j++;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// AST + parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, ValueNode>;
  selections: SelectionNode[] | null;
}
interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selections: SelectionNode[];
}
interface SpreadNode {
  kind: 'spread';
  name: string;
}
type SelectionNode = FieldNode | InlineFragmentNode | SpreadNode;

interface VarDef {
  name: string;
  defaultValue: ValueNode | null;
}
interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation';
  name: string | null;
  varDefs: VarDef[];
  selections: SelectionNode[];
}
interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`expected "${v}", got "${t.value}"`);
  }

  private expectName(what = 'name'): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`expected ${what}, got "${t.value}"`);
    return t.value;
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName('directive name');
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  parseDocument(): Array<OperationNode | FragmentNode> {
    const defs: Array<OperationNode | FragmentNode> = [];
    while (this.peek().kind !== 'eof') {
      defs.push(this.parseDefinition());
    }
    return defs;
  }

  private parseDefinition(): OperationNode | FragmentNode {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '{') {
      return { kind: 'operation', operation: 'query', name: null, varDefs: [], selections: this.parseSelectionSet() };
    }
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      const operation = this.next().value as 'query' | 'mutation';
      let name: string | null = null;
      if (this.peek().kind === 'name') name = this.next().value;
      let varDefs: VarDef[] = [];
      if (this.peek().kind === 'punct' && this.peek().value === '(') varDefs = this.parseVarDefs();
      this.skipDirectives();
      return { kind: 'operation', operation, name, varDefs, selections: this.parseSelectionSet() };
    }
    if (t.kind === 'name' && t.value === 'fragment') {
      this.next();
      const name = this.expectName('fragment name');
      const on = this.expectName('"on"');
      if (on !== 'on') throw new Error('expected "on" in fragment definition');
      const typeCondition = this.expectName('type condition');
      this.skipDirectives();
      return { kind: 'fragment', name, typeCondition, selections: this.parseSelectionSet() };
    }
    throw new Error(`unexpected definition start "${t.value}"`);
  }

  private parseVarDefs(): VarDef[] {
    this.expectPunct('(');
    const defs: VarDef[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      this.expectPunct('$');
      const name = this.expectName('variable name');
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.peek().kind === 'punct' && this.peek().value === '=') {
        this.next();
        defaultValue = this.parseValue();
      }
      this.skipDirectives();
      defs.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  private parseType(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName('type name');
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const sels: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      sels.push(this.parseSelection());
    }
    this.expectPunct('}');
    return sels;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'ellipsis') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName('type condition');
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() };
    }
    let name = this.expectName('field name');
    let alias: string | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName('field name');
    }
    let args: Record<string, ValueNode> = {};
    if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
    this.skipDirectives();
    let selections: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): Record<string, ValueNode> {
    this.expectPunct('(');
    const args: Record<string, ValueNode> = {};
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName('argument name');
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') {
      return { kind: 'variable', name: this.expectName('variable name') };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName('input field name');
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'int') return { kind: 'int', value: parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: parseFloat(t.value) };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`unexpected value token "${t.value}"`);
  }
}

// ---------------------------------------------------------------------------
// Schema: field return types (for validation) and resolvers (for execution)
// ---------------------------------------------------------------------------

const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);

const FIELD_TYPES: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  User: { id: 'ID', databaseId: 'Int', login: 'String', name: 'String', email: 'String', avatarUrl: 'String', url: 'String' },
  Node: { id: 'ID' },
  Repository: {
    id: 'ID', databaseId: 'Int', name: 'String', nameWithOwner: 'String', description: 'String', url: 'String',
    isPrivate: 'Boolean', owner: 'User', defaultBranchRef: 'Ref', viewerPermission: 'String', hasIssuesEnabled: 'Boolean',
    issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest',
    createdAt: 'String', updatedAt: 'String',
  },
  Ref: { name: 'String', target: 'Commit' },
  Commit: { oid: 'String', abbreviatedOid: 'String', message: 'String' },
  Issue: {
    id: 'ID', databaseId: 'Int', number: 'Int', title: 'String', body: 'String', state: 'String',
    createdAt: 'String', updatedAt: 'String', closedAt: 'String', author: 'User', url: 'String',
    closed: 'Boolean', locked: 'Boolean',
  },
  IssueConnection: { nodes: '[Issue]', edges: '[IssueEdge]', pageInfo: 'PageInfo', totalCount: 'Int' },
  IssueEdge: { node: 'Issue', cursor: 'String' },
  PageInfo: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', startCursor: 'String', endCursor: 'String' },
  PullRequest: {
    id: 'ID', databaseId: 'Int', number: 'Int', title: 'String', body: 'String', state: 'String',
    merged: 'Boolean', mergeable: 'String', headRefName: 'String', baseRefName: 'String',
    headRef: 'Ref', baseRef: 'Ref', files: 'PullRequestChangedFileConnection',
    mergedAt: 'String', createdAt: 'String', updatedAt: 'String', author: 'User', url: 'String',
    additions: 'Int', deletions: 'Int', changedFiles: 'Int', isDraft: 'Boolean', reviewDecision: 'String',
  },
  PullRequestConnection: { nodes: '[PullRequest]', edges: '[PullRequestEdge]', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestEdge: { node: 'PullRequest', cursor: 'String' },
  PullRequestChangedFileConnection: { nodes: '[PullRequestChangedFile]', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestChangedFile: { path: 'String', additions: 'Int', deletions: 'Int', changeType: 'String' },
  __Type: {
    name: 'String', kind: 'String', description: 'String', fields: '[__Field]',
    enumValues: '[__EnumValue]', inputFields: '[__InputValue]', interfaces: '[__Type]', possibleTypes: '[__Type]',
  },
  __Field: { name: 'String', description: 'String', args: '[__InputValue]', type: '__Type' },
  __EnumValue: { name: 'String', description: 'String' },
  __InputValue: { name: 'String', description: 'String' },
  IssueComment: { id: 'ID', databaseId: 'Int', body: 'String', author: 'User', createdAt: 'String', updatedAt: 'String', url: 'String' },
  IssueCommentEdge: { node: 'IssueComment', cursor: 'String' },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CloseIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge', subject: 'Issue', clientMutationId: 'String' },
};

function unwrap(type: string): string {
  return type.replace(/^\[/, '').replace(/\]$/, '').replace(/!$/, '');
}

function isListType(type: string): boolean {
  return type.startsWith('[');
}

// Introspection tables.
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'closedAt', 'author', 'url', 'closed', 'locked', 'comments', 'labels', 'assignees', 'milestone', 'repository'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'mergedAt', 'createdAt', 'updatedAt', 'author', 'url', 'additions', 'deletions', 'changedFiles', 'isDraft', 'reviewDecision', 'commits', 'reviews'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'description', 'url', 'isPrivate', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt', 'forkCount', 'stargazerCount'],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'avatarUrl', 'url'],
  Ref: ['name', 'target'],
  Commit: ['oid', 'abbreviatedOid', 'message'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
};
const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrder: [],
};

// ---------------------------------------------------------------------------
// Value objects
// ---------------------------------------------------------------------------

interface Ctx {
  store: Store;
}

function userObj(): Record<string, unknown> {
  return {
    __typename: 'User',
    id: globalId('User', String(VIEWER.id)),
    databaseId: VIEWER.id,
    login: VIEWER.login,
    name: VIEWER.name,
    email: VIEWER.email,
    avatarUrl: '',
    url: `https://github.invalid/${VIEWER.login}`,
  };
}

function repoObj(repo: Repo): Record<string, unknown> {
  return { __typename: 'Repository', repo };
}

function issueObj(repo: Repo, issue: Issue): Record<string, unknown> {
  return { __typename: 'Issue', repo, issue };
}

function pullObj(repo: Repo, pull: Pull): Record<string, unknown> {
  return { __typename: 'PullRequest', repo, pull };
}

function refObj(repo: Repo, name: string, oid: string | null): Record<string, unknown> {
  return { __typename: 'Ref', repo, name, oid };
}

function pageInfoObj(hasNextPage: boolean, hasPreviousPage: boolean, startCursor: string | null, endCursor: string | null): Record<string, unknown> {
  return { __typename: 'PageInfo', hasNextPage, hasPreviousPage, startCursor, endCursor };
}

function cursorFor(kind: string, n: number): string {
  return Buffer.from(`cursor:${kind}:${n}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: string | null | undefined, kind: string): number | null {
  if (!cursor) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length === 3 && parts[0] === 'cursor' && parts[1] === kind) {
      const n = parseInt(parts[2], 10);
      return Number.isInteger(n) ? n : null;
    }
    return null;
  } catch {
    return null;
  }
}

function repoById(store: Store, id: number): Repo | null {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return null;
}

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

type Resolver = (obj: Record<string, unknown>, args: Record<string, unknown>, ctx: Ctx) => unknown;

function issuesConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  let items = [...repo.issues];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const want = new Set(states.map((s) => String(s).toLowerCase()));
    items = items.filter((i) => want.has(i.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const direction = orderBy?.direction === 'ASC' ? 1 : orderBy?.direction === 'DESC' ? -1 : 1;
  const field = orderBy?.field ?? 'CREATED_AT';
  const key = (i: Issue): number => (field === 'UPDATED_AT' ? i.updatedSeq : i.seq);
  items.sort((a, b) => (key(a) - key(b)) * direction);
  const afterNum = cursorNumber(args.after as string | null, 'issue');
  if (afterNum !== null) {
    const idx = items.findIndex((i) => i.number === afterNum);
    if (idx !== -1) items = items.slice(idx + 1);
  }
  const first = typeof args.first === 'number' ? args.first : items.length;
  const page = items.slice(0, first);
  const hasNextPage = items.length > page.length;
  const nodes = page.map((i) => issueObj(repo, i));
  return {
    __typename: 'IssueConnection',
    nodes,
    edges: page.map((i) => ({ __typename: 'IssueEdge', node: issueObj(repo, i), cursor: cursorFor('issue', i.number) })),
    pageInfo: pageInfoObj(
      hasNextPage,
      afterNum !== null,
      page.length > 0 ? cursorFor('issue', page[0].number) : null,
      page.length > 0 ? cursorFor('issue', page[page.length - 1].number) : null,
    ),
    totalCount: repo.issues.length,
  };
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  let items = [...repo.pulls];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const want = new Set(states.map((s) => String(s)));
    items = items.filter((p) => want.has(pullState(p)));
  }
  items.sort((a, b) => b.seq - a.seq);
  const afterNum = cursorNumber(args.after as string | null, 'pull');
  if (afterNum !== null) {
    const idx = items.findIndex((p) => p.number === afterNum);
    if (idx !== -1) items = items.slice(idx + 1);
  }
  const first = typeof args.first === 'number' ? args.first : items.length;
  const page = items.slice(0, first);
  const hasNextPage = items.length > page.length;
  const nodes = page.map((p) => pullObj(repo, p));
  return {
    __typename: 'PullRequestConnection',
    nodes,
    edges: page.map((p) => ({ __typename: 'PullRequestEdge', node: pullObj(repo, p), cursor: cursorFor('pull', p.number) })),
    pageInfo: pageInfoObj(
      hasNextPage,
      afterNum !== null,
      page.length > 0 ? cursorFor('pull', page[0].number) : null,
      page.length > 0 ? cursorFor('pull', page[page.length - 1].number) : null,
    ),
    totalCount: repo.pulls.length,
  };
}

function pullState(pull: Pull): 'OPEN' | 'CLOSED' | 'MERGED' {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function filesConnection(repo: Repo, pull: Pull, args: Record<string, unknown>): Record<string, unknown> {
  const files = pullFiles(repo, pull) ?? [];
  const first = typeof args.first === 'number' ? args.first : files.length;
  const page = files.slice(0, first);
  const statusToChange: Record<string, string> = { added: 'ADDED', removed: 'REMOVED', modified: 'MODIFIED' };
  return {
    __typename: 'PullRequestChangedFileConnection',
    nodes: page.map((f) => ({
      __typename: 'PullRequestChangedFile',
      path: f.filename,
      additions: f.additions,
      deletions: f.deletions,
      changeType: statusToChange[String(f.status)] ?? 'MODIFIED',
    })),
    pageInfo: pageInfoObj(files.length > page.length, false, null, null),
    totalCount: files.length,
  };
}

class GQLError extends Error {}

function decodeRepoRef(ctx: Ctx, global: unknown): Repo {
  const decoded = typeof global === 'string' ? decodeGlobalId(global) : null;
  if (!decoded || decoded.kind !== 'Repository') throw new GQLError('invalid repository id');
  const repo = repoById(ctx.store, parseInt(decoded.key, 10));
  if (!repo) throw new GQLError('repository not found');
  return repo;
}

function decodeIssueRef(ctx: Ctx, global: unknown): { repo: Repo; issue: Issue } {
  const decoded = typeof global === 'string' ? decodeGlobalId(global) : null;
  if (!decoded || decoded.kind !== 'Issue') throw new GQLError('invalid issue id');
  const [repoId, num] = decoded.key.split(':').map((s) => parseInt(s, 10));
  const repo = repoById(ctx.store, repoId);
  const issue = repo?.issues.find((i) => i.number === num);
  if (!repo || !issue) throw new GQLError('issue not found');
  return { repo, issue };
}

function decodePullRef(ctx: Ctx, global: unknown): { repo: Repo; pull: Pull } {
  const decoded = typeof global === 'string' ? decodeGlobalId(global) : null;
  if (!decoded || decoded.kind !== 'PullRequest') throw new GQLError('invalid pull request id');
  const [repoId, num] = decoded.key.split(':').map((s) => parseInt(s, 10));
  const repo = repoById(ctx.store, repoId);
  const pull = repo?.pulls.find((p) => p.number === num);
  if (!repo || !pull) throw new GQLError('pull request not found');
  return { repo, pull };
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  User: {
    id: (o) => o.id,
    databaseId: (o) => o.databaseId,
    login: (o) => o.login,
    name: (o) => o.name,
    email: (o) => o.email,
    avatarUrl: (o) => o.avatarUrl,
    url: (o) => o.url,
  },
  Query: {
    viewer: () => userObj(),
    repository: (_o, args, ctx) => {
      if (args.owner !== VIEWER.login) return null;
      const repo = ctx.store.getRepo(String(args.name ?? ''));
      return repo ? repoObj(repo) : null;
    },
    node: (_o, args, ctx) => {
      const decoded = typeof args.id === 'string' ? decodeGlobalId(args.id) : null;
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const repo = repoById(ctx.store, parseInt(decoded.key, 10));
        return repo ? repoObj(repo) : null;
      }
      if (decoded.kind === 'Issue') {
        try {
          const { repo, issue } = decodeIssueRef(ctx, args.id);
          return issueObj(repo, issue);
        } catch {
          return null;
        }
      }
      if (decoded.kind === 'PullRequest') {
        try {
          const { repo, pull } = decodePullRef(ctx, args.id);
          return pullObj(repo, pull);
        } catch {
          return null;
        }
      }
      return null;
    },
    __type: (_o, args) => {
      const name = String(args.name ?? '');
      if (TYPE_FIELDS[name]) {
        return { __typename: '__Type', name, kind: 'OBJECT', fieldNames: TYPE_FIELDS[name], enumNames: null };
      }
      if (TYPE_ENUMS[name]) {
        return { __typename: '__Type', name, kind: 'ENUM', fieldNames: null, enumNames: TYPE_ENUMS[name] };
      }
      if (FIELD_TYPES[name]) {
        return { __typename: '__Type', name, kind: 'OBJECT', fieldNames: Object.keys(FIELD_TYPES[name]), enumNames: null };
      }
      if (['String', 'Int', 'Float', 'Boolean', 'ID'].includes(name)) {
        return { __typename: '__Type', name, kind: 'SCALAR', fieldNames: null, enumNames: null };
      }
      return null;
    },
  },
  Repository: {
    id: (o) => globalId('Repository', String((o.repo as Repo).id)),
    databaseId: (o) => (o.repo as Repo).id,
    name: (o) => (o.repo as Repo).name,
    nameWithOwner: (o) => `${VIEWER.login}/${(o.repo as Repo).name}`,
    description: (o) => (o.repo as Repo).description,
    url: (o) => `https://github.invalid/${VIEWER.login}/${(o.repo as Repo).name}`,
    isPrivate: (o) => (o.repo as Repo).private,
    owner: () => userObj(),
    defaultBranchRef: (o) => {
      const repo = o.repo as Repo;
      return refObj(repo, repo.defaultBranch, branchTip(repo, repo.defaultBranch));
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (o, args) => {
      const repo = o.repo as Repo;
      const found = repo.issues.find((i) => i.number === args.number);
      return found ? issueObj(repo, found) : null;
    },
    issues: (o, args) => issuesConnection(o.repo as Repo, args),
    pullRequests: (o, args) => pullsConnection(o.repo as Repo, args),
    pullRequest: (o, args) => {
      const repo = o.repo as Repo;
      const found = repo.pulls.find((p) => p.number === args.number);
      return found ? pullObj(repo, found) : null;
    },
    createdAt: (o) => (o.repo as Repo).createdAt,
    updatedAt: (o) => (o.repo as Repo).updatedAt,
  },
  Ref: {
    name: (o) => o.name as string,
    target: (o) => {
      const repo = o.repo as Repo;
      const oid = o.oid as string | null;
      if (!oid) return null;
      const commit = getCommit(repo, oid);
      return { __typename: 'Commit', oid, message: commit?.message ?? '' };
    },
  },
  Commit: {
    oid: (o) => o.oid as string,
    abbreviatedOid: (o) => (o.oid as string).slice(0, 7),
    message: (o) => (o.message as string) ?? '',
  },
  Issue: {
    id: (o) => globalId('Issue', `${(o.repo as Repo).id}:${(o.issue as Issue).number}`),
    databaseId: (o) => (o.issue as Issue).id,
    number: (o) => (o.issue as Issue).number,
    title: (o) => (o.issue as Issue).title,
    body: (o) => (o.issue as Issue).body,
    state: (o) => ((o.issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
    createdAt: (o) => (o.issue as Issue).createdAt,
    updatedAt: (o) => (o.issue as Issue).updatedAt,
    closedAt: (o) => (o.issue as Issue).closedAt,
    author: () => userObj(),
    url: (o) => `https://github.invalid/${VIEWER.login}/${(o.repo as Repo).name}/issues/${(o.issue as Issue).number}`,
    closed: (o) => (o.issue as Issue).state === 'closed',
    locked: () => false,
  },
  IssueConnection: {
    nodes: (o) => o.nodes,
    edges: (o) => o.edges,
    pageInfo: (o) => o.pageInfo,
    totalCount: (o) => o.totalCount,
  },
  IssueEdge: { node: (o) => o.node, cursor: (o) => o.cursor },
  PageInfo: {
    hasNextPage: (o) => o.hasNextPage,
    hasPreviousPage: (o) => o.hasPreviousPage,
    startCursor: (o) => o.startCursor,
    endCursor: (o) => o.endCursor,
  },
  PullRequest: {
    id: (o) => globalId('PullRequest', `${(o.repo as Repo).id}:${(o.pull as Pull).number}`),
    databaseId: (o) => (o.pull as Pull).id,
    number: (o) => (o.pull as Pull).number,
    title: (o) => (o.pull as Pull).title,
    body: (o) => (o.pull as Pull).body,
    state: (o) => pullState(o.pull as Pull),
    merged: (o) => (o.pull as Pull).merged,
    mergeable: (o) => pullMergeable(o.repo as Repo, o.pull as Pull),
    headRefName: (o) => (o.pull as Pull).headRef,
    baseRefName: (o) => (o.pull as Pull).baseRef,
    headRef: (o) => {
      const repo = o.repo as Repo;
      const pull = o.pull as Pull;
      return refObj(repo, pull.headRef, branchTip(repo, pull.headRef) ?? pull.headSha);
    },
    baseRef: (o) => {
      const repo = o.repo as Repo;
      const pull = o.pull as Pull;
      return refObj(repo, pull.baseRef, branchTip(repo, pull.baseRef) ?? pull.baseSha);
    },
    files: (o, args) => filesConnection(o.repo as Repo, o.pull as Pull, args),
    mergedAt: (o) => (o.pull as Pull).mergedAt,
    createdAt: (o) => (o.pull as Pull).createdAt,
    updatedAt: (o) => (o.pull as Pull).updatedAt,
    author: () => userObj(),
    url: (o) => `https://github.invalid/${VIEWER.login}/${(o.repo as Repo).name}/pull/${(o.pull as Pull).number}`,
    additions: (o) => (pullFiles(o.repo as Repo, o.pull as Pull) ?? []).reduce((s, f) => s + Number(f.additions), 0),
    deletions: (o) => (pullFiles(o.repo as Repo, o.pull as Pull) ?? []).reduce((s, f) => s + Number(f.deletions), 0),
    changedFiles: (o) => (pullFiles(o.repo as Repo, o.pull as Pull) ?? []).length,
    isDraft: () => false,
    reviewDecision: () => null,
  },
  PullRequestConnection: {
    nodes: (o) => o.nodes,
    edges: (o) => o.edges,
    pageInfo: (o) => o.pageInfo,
    totalCount: (o) => o.totalCount,
  },
  PullRequestEdge: { node: (o) => o.node, cursor: (o) => o.cursor },
  PullRequestChangedFileConnection: {
    nodes: (o) => o.nodes,
    pageInfo: (o) => o.pageInfo,
    totalCount: (o) => o.totalCount,
  },
  PullRequestChangedFile: {
    path: (o) => o.path,
    additions: (o) => o.additions,
    deletions: (o) => o.deletions,
    changeType: (o) => o.changeType,
  },
  __Type: {
    name: (o) => o.name,
    kind: (o) => o.kind,
    description: () => null,
    fields: (o) => {
      const names = o.fieldNames as string[] | null;
      if (!names) return null;
      return names.map((n) => ({ __typename: '__Field', name: n }));
    },
    enumValues: (o) => {
      const names = o.enumNames as string[] | null;
      if (!names) return null;
      return names.map((n) => ({ __typename: '__EnumValue', name: n }));
    },
    inputFields: () => null,
    interfaces: () => [],
    possibleTypes: () => [],
  },
  __Field: {
    name: (o) => o.name,
    description: () => null,
    args: () => [],
    type: () => ({ __typename: '__Type', name: 'String', kind: 'SCALAR', fieldNames: null, enumNames: null }),
  },
  __EnumValue: { name: (o) => o.name, description: () => null },
  __InputValue: { name: (o) => o.name, description: () => null },
  IssueComment: {
    id: (o) => o.id,
    databaseId: (o) => o.databaseId,
    body: (o) => o.body,
    author: () => userObj(),
    createdAt: (o) => o.createdAt,
    updatedAt: (o) => o.updatedAt,
    url: (o) => o.url,
  },
  IssueCommentEdge: { node: (o) => o.node, cursor: (o) => o.cursor ?? null },
  CreateIssuePayload: { issue: (o) => o.issue, clientMutationId: (o) => o.clientMutationId ?? null },
  CloseIssuePayload: { issue: (o) => o.issue, clientMutationId: (o) => o.clientMutationId ?? null },
  CreatePullRequestPayload: { pullRequest: (o) => o.pullRequest, clientMutationId: (o) => o.clientMutationId ?? null },
  MergePullRequestPayload: { pullRequest: (o) => o.pullRequest, clientMutationId: (o) => o.clientMutationId ?? null },
  AddCommentPayload: { commentEdge: (o) => o.commentEdge, subject: (o) => o.subject ?? null, clientMutationId: (o) => o.clientMutationId ?? null },
  Mutation: {
    createIssue: (_o, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = decodeRepoRef(ctx, input.repositoryId);
      const title = input.title as string | undefined;
      if (!title) throw new GQLError('title is required');
      const now = nowIso();
      const issue: Issue = {
        id: ctx.store.nextIssueId(),
        number: ++repo.issueSeq,
        title,
        body: (input.body as string) ?? '',
        state: 'open',
        labels: [],
        comments: [],
        seq: ctx.store.nextOpSeq(),
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        updatedSeq: ctx.store.nextOpSeq(),
        cachedBody: null,
      };
      repo.issues.push(issue);
      return { __typename: 'CreateIssuePayload', issue: issueObj(repo, issue), clientMutationId: input.clientMutationId ?? null };
    },
    closeIssue: (_o, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const { repo, issue } = decodeIssueRef(ctx, input.issueId);
      issue.state = 'closed';
      issue.closedAt = nowIso();
      issue.updatedAt = nowIso();
      issue.updatedSeq = ctx.store.nextOpSeq();
      invalidateIssue(issue);
      return { __typename: 'CloseIssuePayload', issue: issueObj(repo, issue), clientMutationId: input.clientMutationId ?? null };
    },
    createPullRequest: (_o, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = decodeRepoRef(ctx, input.repositoryId);
      const created = createPullFromFields(ctx.store, repo, {
        title: (input.title as string) ?? null,
        body: (input.body as string) ?? null,
        head: (input.headRefName as string) ?? null,
        base: (input.baseRefName as string) ?? null,
      });
      if ('error' in created) throw new GQLError('could not create pull request');
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullObj(repo, created.pull), clientMutationId: input.clientMutationId ?? null };
    },
    mergePullRequest: (_o, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const { repo, pull } = decodePullRef(ctx, input.pullRequestId);
      const merged = mergePull(repo, pull, (input.commitHeadline as string) ?? null);
      if ('error' in merged) throw new GQLError('could not merge pull request');
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObj(repo, pull), clientMutationId: input.clientMutationId ?? null };
    },
    addComment: (_o, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const { repo, issue } = decodeIssueRef(ctx, input.subjectId);
      const body = (input.body as string) ?? '';
      const now = nowIso();
      const comment = { id: ctx.store.nextCommentId(), body, createdAt: now, updatedAt: now };
      issue.comments.push(comment);
      issue.updatedAt = now;
      issue.updatedSeq = ctx.store.nextOpSeq();
      invalidateIssue(issue);
      const node = {
        __typename: 'IssueComment',
        id: globalId('IssueComment', `${repo.id}:${comment.id}`),
        databaseId: comment.id,
        body,
        createdAt: now,
        updatedAt: now,
        url: `https://github.invalid/${VIEWER.login}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
      };
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node, cursor: null },
        subject: issueObj(repo, issue),
        clientMutationId: input.clientMutationId ?? null,
      };
    },
  },
};

// ---------------------------------------------------------------------------
// Validation + execution
// ---------------------------------------------------------------------------

function valueFromNode(node: ValueNode, variables: Record<string, unknown>, varDefs: VarDef[]): unknown {
  switch (node.kind) {
    case 'variable': {
      if (node.name in variables) return variables[node.name] ?? null;
      const def = varDefs.find((d) => d.name === node.name);
      if (def?.defaultValue) return valueFromNode(def.defaultValue, variables, varDefs);
      return null;
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => valueFromNode(v, variables, varDefs));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = valueFromNode(f.value, variables, varDefs);
      return out;
    }
  }
}

function validateSelections(
  selections: SelectionNode[],
  parentType: string,
  fragments: Map<string, FragmentNode>,
  errors: string[],
  depth: number,
): void {
  if (depth > 64) {
    errors.push('selection set too deep');
    return;
  }
  for (const sel of selections) {
    if (sel.kind === 'spread') {
      const frag = fragments.get(sel.name);
      if (!frag) {
        errors.push(`unknown fragment "${sel.name}"`);
        continue;
      }
      validateSelections(frag.selections, frag.typeCondition, fragments, errors, depth + 1);
      continue;
    }
    if (sel.kind === 'inline') {
      validateSelections(sel.selections, sel.typeCondition ?? parentType, fragments, errors, depth + 1);
      continue;
    }
    if (sel.name === '__typename') continue;
    const fields = FIELD_TYPES[parentType];
    const returnType = fields?.[sel.name];
    if (!returnType) {
      errors.push(`Cannot query field "${sel.name}" on type "${parentType}".`);
      continue;
    }
    if (sel.selections) {
      const base = unwrap(returnType);
      if (SCALARS.has(base)) {
        errors.push(`Field "${sel.name}" must not have a selection since type "${base}" has no subfields.`);
        continue;
      }
      validateSelections(sel.selections, base, fragments, errors, depth + 1);
    }
  }
}

function executeSelections(
  selections: SelectionNode[],
  parentType: string,
  parentValue: Record<string, unknown>,
  ctx: Ctx,
  variables: Record<string, unknown>,
  varDefs: VarDef[],
  fragments: Map<string, FragmentNode>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'spread') {
      const frag = fragments.get(sel.name);
      if (!frag) continue;
      if (frag.typeCondition !== (parentValue.__typename as string) && frag.typeCondition !== parentType) continue;
      Object.assign(out, executeSelections(frag.selections, frag.typeCondition, parentValue, ctx, variables, varDefs, fragments));
      continue;
    }
    if (sel.kind === 'inline') {
      if (sel.typeCondition && sel.typeCondition !== (parentValue.__typename as string) && sel.typeCondition !== parentType) continue;
      Object.assign(out, executeSelections(sel.selections, sel.typeCondition ?? parentType, parentValue, ctx, variables, varDefs, fragments));
      continue;
    }
    const key = sel.alias ?? sel.name;
    if (sel.name === '__typename') {
      out[key] = parentValue.__typename as string;
      continue;
    }
    const resolver =
      RESOLVERS[parentType]?.[sel.name] ??
      (typeof parentValue.__typename === 'string' ? RESOLVERS[parentValue.__typename]?.[sel.name] : undefined);
    if (!resolver) {
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [name, node] of Object.entries(sel.args)) args[name] = valueFromNode(node, variables, varDefs);
    const value = resolver(parentValue, args, ctx);
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    if (!sel.selections) {
      out[key] = value;
      continue;
    }
    const returnType = FIELD_TYPES[parentType]?.[sel.name] ?? 'String';
    const base = unwrap(returnType);
    if (isListType(returnType) && Array.isArray(value)) {
      out[key] = value.map((item) =>
        item === null || typeof item !== 'object'
          ? item
          : executeSelections(sel.selections!, base, item as Record<string, unknown>, ctx, variables, varDefs, fragments),
      );
    } else if (typeof value === 'object') {
      out[key] = executeSelections(sel.selections, base, value as Record<string, unknown>, ctx, variables, varDefs, fragments);
    } else {
      out[key] = value;
    }
  }
  return out;
}

interface GQLRequest {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

function executeOperation(store: Store, request: GQLRequest): Record<string, unknown> {
  if (typeof request.query !== 'string') {
    return { data: null, errors: [{ message: 'Must provide query string.' }] };
  }
  let defs: Array<OperationNode | FragmentNode>;
  try {
    defs = new Parser(lex(request.query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const fragments = new Map<string, FragmentNode>();
  const operations: OperationNode[] = [];
  for (const d of defs) {
    if (d.kind === 'fragment') fragments.set(d.name, d);
    else operations.push(d);
  }
  let operation: OperationNode | undefined;
  if (typeof request.operationName === 'string' && request.operationName !== '') {
    operation = operations.find((o) => o.name === request.operationName);
    if (!operation) return { data: null, errors: [{ message: `unknown operation "${request.operationName}"` }] };
  } else {
    if (operations.length !== 1) {
      return { data: null, errors: [{ message: 'must provide operation name when multiple operations are present' }] };
    }
    operation = operations[0];
  }
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const errors: string[] = [];
  validateSelections(operation.selections, rootType, fragments, errors, 0);
  if (errors.length > 0) {
    return { data: null, errors: errors.map((message) => ({ message })) };
  }
  const variables = (request.variables ?? {}) as Record<string, unknown>;
  const ctx: Ctx = { store };
  try {
    const root: Record<string, unknown> = { __typename: rootType };
    const data = executeSelections(operation.selections, rootType, root, ctx, variables, operation.varDefs, fragments);
    return { data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { data: null, errors: [{ message }] };
  }
}

export function handleGraphQL(store: Store, body: Buffer): HttpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return badRequest('Problems parsing JSON');
  }
  if (Array.isArray(parsed)) {
    return jsonResult(200, parsed.map((item) => executeOperation(store, (item ?? {}) as GQLRequest)));
  }
  if (parsed === null || typeof parsed !== 'object') return badRequest('Problems parsing JSON');
  return jsonResult(200, executeOperation(store, parsed as GQLRequest));
}
