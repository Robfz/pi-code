import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.ts";

describe("loadConfig", () => {
  it("applies the defaults", () => {
    const c = loadConfig({ HOME: "/home/u", PI_CODE_HOSTNAME: "Mac.Tail1234.ts.net" });
    expect(c).toMatchObject({
      port: 4180,
      curatorPort: 4181,
      hostname: "mac.tail1234.ts.net",
      piBin: "pi",
      dataDir: "/home/u/.config/pi-code",
      agentDir: "/home/u/.pi/agent",
      home: "/home/u",
    });
    expect(c.staticDir).toMatch(/packages\/web\/dist$/);
    expect(c.extensionPath).toMatch(/packages\/pi-extension\/src\/index\.ts$/);
  });

  it("reads overrides", () => {
    const c = loadConfig({
      HOME: "/home/u",
      PI_CODE_HOSTNAME: "h.ts.net",
      PI_CODE_PORT: "5000",
      PI_CODE_CURATOR_PORT: "5001",
      PI_CODE_PI_BIN: "/opt/pi",
      PI_CODE_DATA_DIR: "~/data",
      PI_AGENT_DIR: "/abs/agent",
    });
    expect(c).toMatchObject({
      port: 5000,
      curatorPort: 5001,
      piBin: "/opt/pi",
      dataDir: "/home/u/data",
      agentDir: "/abs/agent",
    });
  });

  it("requires PI_CODE_HOSTNAME outside development and test", () => {
    expect(() => loadConfig({ HOME: "/h" })).toThrow(ConfigError);
    expect(() => loadConfig({ HOME: "/h", NODE_ENV: "production" })).toThrow(/PI_CODE_HOSTNAME/);
    expect(loadConfig({ HOME: "/h", NODE_ENV: "development" }).hostname).toBe("localhost");
    expect(loadConfig({ HOME: "/h", NODE_ENV: "test" }).hostname).toBe("localhost");
  });

  it("rejects bad ports and hostnames", () => {
    const base = { HOME: "/h", NODE_ENV: "test" };
    expect(() => loadConfig({ ...base, PI_CODE_PORT: "abc" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, PI_CODE_PORT: "70000" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, PI_CODE_HOSTNAME: "https://x.ts.net" })).toThrow(
      ConfigError,
    );
  });
});
