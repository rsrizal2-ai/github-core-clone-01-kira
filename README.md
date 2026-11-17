# {repo}

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/{owner}/{repo}/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/{owner}/{repo}/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in stdlib-only TypeScript: git smart HTTP (protocol v2 and v0), REST API v3, GraphQL v4, and an MCP endpoint — one in-memory store behind all four surfaces.

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` speaks the make.fun entry lifecycle: it binds an ephemeral port, registers it at `$MAKEFUN_ENV_URL/register`, and polls `$MAKEFUN_ENV_URL/done` until the trial ends. For local development, `dev-server.ts` starts the same server on a fixed port:

```sh
MAKEFUN_SHOP_TOKEN=test-token PORT=18080 node --experimental-strip-types dev-server.ts
```

## Layout

- `main.ts` — entry lifecycle (bind, register, wait for done).
- `app.ts` — HTTP server: routing, bearer auth, request ids.
- `store.ts` — in-memory state: git objects, refs, issues, pull requests.
- `pack.ts` — pkt-line framing and packfile read/write (deltas on read).
- `gitproto.ts` — git smart HTTP: advertisements, ls-refs, fetch, receive-pack.
- `rest.ts` — REST API v3.
- `graphql.ts` — GraphQL v4 parser and executor.
- `mcp.ts` — MCP tools over Streamable HTTP.

---

<sub>Entered on [make.fun](https://make.fun/?ref={referral_code}&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
