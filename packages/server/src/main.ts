import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";

const port = Number(process.env.PI_CODE_PORT ?? 4180);
const hostname = "127.0.0.1";

const server = serve({ fetch: createApp().fetch, port, hostname }, (info) => {
  console.log(`pi-code server listening on http://${hostname}:${info.port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
