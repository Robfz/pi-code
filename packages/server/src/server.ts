import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { AgentManager, piCommand } from "./agents/agent-manager.ts";
import { createApp } from "./app.ts";
import { SessionCatalog } from "./catalog/sessions.ts";
import type { Config } from "./config.ts";
import { CuratorProxy } from "./curator/proxy.ts";
import { CuratorRegistry } from "./curator/registry.ts";
import { piVersionProbe } from "./pi-version.ts";
import { type PushSender, PushService } from "./push/push-service.ts";
import { SubscriptionStore } from "./push/subscriptions.ts";
import { loadVapidDetails } from "./push/vapid.ts";

export const LISTEN_HOST = "127.0.0.1";

export interface StartOptions {
  /** Replaces `web-push` (tests). */
  pushSender?: PushSender;
}

export interface RunningServer {
  port: number;
  curatorPort: number;
  manager: AgentManager;
  push: PushService;
  curators: CuratorRegistry;
  /**
   * Graceful shutdown: stop accepting requests, close every agent in parallel (end stdin,
   * SIGTERM after 5 s, SIGKILL after 10 s), then drop the remaining connections.
   */
  shutdown(): Promise<void>;
}

function listening(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error) => reject(e);
    server.once("error", onError);
    const ready = () => {
      server.off("error", onError);
      resolve((server.address() as AddressInfo).port);
    };
    if (server.listening) ready();
    else server.once("listening", ready);
  });
}

/** Wires everything together and starts both listeners on `127.0.0.1`. */
export async function startServer(config: Config, opts: StartOptions = {}): Promise<RunningServer> {
  const curators = new CuratorRegistry({
    hostname: config.hostname,
    proxyPort: config.curatorPort,
  });

  let push: PushService | undefined;
  const manager = new AgentManager({
    home: config.home,
    command: piCommand(config.piBin, config.extensionPath),
    agentDir: config.agentDir,
    pipeline: { curator: curators },
    onTrigger: (trigger) => void push?.notify(trigger),
  });

  push = new PushService({
    vapid: await loadVapidDetails(config.dataDir, config.hostname),
    store: new SubscriptionStore(config.dataDir),
    agents: manager,
    ...(opts.pushSender ? { send: opts.pushSender } : {}),
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
    push,
    piVersion: piVersionProbe(config.piBin),
  });

  const server = serve({ fetch: app.fetch, port: config.port, hostname: LISTEN_HOST }) as Server;
  const port = await listening(server);

  const proxy = new CuratorProxy({ hostname: config.hostname, registry: curators });
  let curatorPort: number;
  try {
    curatorPort = await proxy.listen(config.curatorPort, LISTEN_HOST);
  } catch (e) {
    server.close();
    throw e;
  }

  let stopping: Promise<void> | undefined;
  const shutdown = () => {
    stopping ??= (async () => {
      server.close();
      server.closeIdleConnections();
      const proxyClosed = proxy.close();
      await manager.closeAll();
      server.closeAllConnections();
      await proxyClosed;
      await push.idle();
    })();
    return stopping;
  };

  return { port, curatorPort, manager, push, curators, shutdown };
}
