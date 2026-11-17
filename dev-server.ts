// Local development runner: start the forge on a fixed port without the env
// lifecycle, so the kit's local suite can grade it directly. Not used by the
// trial; the trial runs main.ts.
//
//   MAKEFUN_SHOP_TOKEN=test-token PORT=18080 node --experimental-strip-types dev-server.ts

import { createApp } from './app.ts';

const port = Number(process.env.PORT ?? 18080);
const server = createApp();
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`[forge] listening on http://127.0.0.1:${port}\n`);
});
