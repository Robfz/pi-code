import type { ServerEvent } from "@pi-code/protocol";
import { describe, expect, it } from "vitest";
import { EventLog } from "../agents/event-log.ts";
import { eventFrameData } from "./stream.ts";

describe("eventFrameData", () => {
  it("is byte-identical to stringifying the whole event frame", () => {
    const events: ServerEvent[] = [
      { type: "ui_resolved", id: "a" },
      { type: "ui_resolved", id: 'é😀 "quoted" \\ \n\u2028 </script>' },
      { type: "bash_output", id: "c1", delta: "a\tb\r\n\u0000", command: "ls" },
      { type: "git_status", status: null },
    ];
    const log = new EventLog();
    for (const agentId of ["agent-1", 'odd "id" é']) {
      for (const event of events) {
        const logged = log.append(event);
        expect(eventFrameData(agentId, logged)).toBe(
          JSON.stringify({ type: "event", agentId, seq: logged.seq, event }),
        );
      }
    }
  });
});
