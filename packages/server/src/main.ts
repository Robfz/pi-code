import { type Config, ConfigError, loadConfig } from "./config.ts";
import { LISTEN_HOST, startServer } from "./server.ts";

let config: Config;
try {
  config = loadConfig();
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(`pi-code: ${e.message}`);
    process.exit(1);
  }
  throw e;
}

let running: Awaited<ReturnType<typeof startServer>>;
try {
  running = await startServer(config);
} catch (e) {
  console.error(`pi-code: failed to start: ${(e as Error).message}`);
  process.exit(1);
}

console.log(
  `pi-code server listening on http://${LISTEN_HOST}:${running.port} (https://${config.hostname}), ` +
    `curator proxy on http://${LISTEN_HOST}:${running.curatorPort}`,
);

let signals = 0;
function onSignal(signal: NodeJS.Signals) {
  signals += 1;
  if (signals > 1) {
    console.error(`pi-code: ${signal} again, exiting now`);
    process.exit(1);
  }
  console.log(`pi-code: ${signal}, closing agents…`);
  running.shutdown().then(
    () => process.exit(0),
    (e: unknown) => {
      console.error("pi-code: shutdown failed:", e);
      process.exit(1);
    },
  );
}
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
