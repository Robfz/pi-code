# Test fixtures and helpers

- `fixtures/` — recorded `pi --mode rpc` sessions as JSONL (commands in, records out), replayed by the fake pi in server and reducer tests.
- `fake-pi.ts` (to come) — a Node script that speaks the pi RPC protocol and replays a fixture.
