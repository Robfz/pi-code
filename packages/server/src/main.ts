import { serve } from "@hono/node-server";
import { AgentManager, piCommand } from "./agents/agent-manager.ts";
import { createApp } from "./app.ts";
import { SessionCatalog } from "./catalog/sessions.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { piVersionProbe } from "./pi-version.ts";

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(`pi-code: ${e.message}`);
    process.exit(1);
  }
  throw e;
}

const LISTEN_HOST = "127.0.0.1";

const manager = new AgentManager({
  home: config.home,
  command: piCommand(config.piBin, config.extensionPath),
  agentDir: config.agentDir,
});

const catalog = new SessionCatalog({
  agentDir: config.agentDir,
  ownerOf: (file) => manager.ownerOf(file),
});

const app = createApp({
  hostname: config.hostname,
  port: config.port,
  staticDir: config.staticDir,
  manager,
  catalog,
  piVersion: piVersionProbe(config.piBin),
});

const server = serve({ fetch: app.fetch, port: config.port, hostname: LISTEN_HOST }, (info) => {
  console.log(
    `pi-code server listening on http://${LISTEN_HOST}:${info.port} (https://${config.hostname})`,
  );
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  await manager.closeAll();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
