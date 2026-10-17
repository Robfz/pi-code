# Perf suite

Timings of pi-code's heavy paths in a real Chromium, for before/after comparisons of performance work (`docs/spikes/performance-audit.md`). It runs on the e2e harness (real server, production build, fake pi; see [`../README.md`](../README.md)) and reports; it never fails on a number.

```sh
pnpm e2e:perf                                  # every scenario, 3 runs, → e2e/results/report-<date>.{json,md}
E2E_PERF_RUNS=5 pnpm e2e:perf                  # more runs per scenario
pnpm e2e:perf --grep cold-load                 # some scenarios (any `playwright test` argument works)
pnpm e2e:compare e2e/results/report-A.json e2e/results/report-B.json [--threshold=0.05]
```

A full run takes about 15 minutes with 3 runs. One worker runs everything in sequence, so scenarios don't compete for the CPU; other load on the machine (another test run, a build) still shows in the numbers.

## Scenarios

Each scenario runs at CPU throttling 1× and 4× (`Emulation.setCPUThrottlingRate`, from just before the measured window), `E2E_PERF_RUNS` times (default 3), in a fresh browser context each time. The runs loop is the outermost, so a burst of load on the machine spreads over all scenarios instead of skewing every run of one. Streams replay at speed 1: the generated fixtures' own spacing (25 ms between text deltas, some in bursts; about 100 ms per tool call), so per-delta work happens at the rate a user sees it.

| Scenario | Projects | Measured window |
|---|---|---|
| `long-stream` | desktop, mobile | Send → run ended on screen: about 1,200 text deltas over 30 s with six code blocks (`long-stream` fixture) |
| `tool-storm` | desktop, mobile | Send → run ended on screen: 200 sequential tool calls over 20 s (`tool-storm` fixture) |
| `cold-load` | desktop, mobile | Navigation to `/agents/<id>` of a finished conversation, empty cache, no service worker → composer enabled and the code block highlighted |
| `multi-agent-review` | desktop | Three `long-stream` agents at once: two prompted through the API, the shown one from the composer, with the review pane open on an uncommitted change → all three ended on screen, and the pane's diff refetched after the git refresh that follows the shown agent's turn |
| `many-conversations-heap` | desktop | 19 conversations opened one after the other from the sidebar (client-side navigation, after a first one opened by URL) |

## Metrics

Every scenario:

| Metric | Source | Meaning |
|---|---|---|
| `durationMs` | wall clock | Length of the window. Fixed by the replay for streams; compare per-second costs with it |
| `mainThread.taskMs` | CDP `Performance.getMetrics` `TaskDuration` | Renderer main-thread busy time in the window |
| `mainThread.scriptMs` / `layoutMs` / `styleMs` | `ScriptDuration` / `LayoutDuration` / `RecalcStyleDuration` | Parts of it: JavaScript, layout, style recalculation |
| `longTasks.count` / `totalMs` / `maxMs` | `PerformanceObserver` `longtask` | Tasks over 50 ms: how often and how long the page could not respond to input |
| `frames.p50Ms` / `p95Ms` / `maxMs` | `requestAnimationFrame` loop | Intervals between frames; 16.7 ms is a frame at 60 Hz |
| `frames.dropped` | the same | Σ over intervals of `round(interval / 16.7 ms) − 1`: the 60 Hz frames that weren't produced |
| `heap.beforeBytes` / `afterBytes` | CDP `HeapProfiler.collectGarbage`, then `JSHeapUsedSize` | Live JS heap at the window's start and end, both after a forced GC |

`cold-load` adds, from the navigation start of the app's document:

| Metric | Source |
|---|---|
| `load.readyMs` | The ready condition (composer enabled, code highlighted), checked every frame |
| `load.ttfbMs` / `domContentLoadedMs` / `loadMs` | Navigation timing: `responseStart`, `domContentLoadedEventEnd`, `loadEventEnd` |
| `load.fcpMs` / `lcpMs` | Paint timing `first-contentful-paint`; the last `largest-contentful-paint` candidate |
| `load.js.requests` / `transferBytes` / `decodedBytes` | Resource timing of `.js` files: count, `transferSize` (body as sent, plus headers), `decodedBodySize` |

Lower is better for every metric.

## Reports

The reporter (`reporter.ts`) collects each passed test's `metrics` attachment and writes `e2e/results/report-<ISO date>.json` and `.md` (gitignored):

- `meta`: date, commit (`+dirty` when the tree has uncommitted changes), runs, Playwright and Chromium versions, the machine's CPU.
- `rows`: one per scenario × project × CPU rate, with every run's metrics (`runs`) and the per-metric medians (`median`, keyed by dotted path such as `mainThread.taskMs`). A row with fewer runs than `meta.runs` had failures; the list reporter shows them.

The markdown has a runtime table (every row) and a load table (`cold-load`).

`pnpm e2e:compare <before.json> <after.json>` prints, for each row in both reports, every median before and after with its change, and marks with ⚠ the ones that changed by the threshold or more (default `0.1`, 10%; any change from 0). It reports only: it never fails. It notes when the reports come from different machines.

## Reading the numbers

- Compare reports from the same machine, taken close together, under similar load. Absolute numbers mean nothing elsewhere.
- Compare a row with the same row (scenario, project, CPU rate) of another report. Rows aren't proportional to each other: the OS schedules the lightly loaded renderer differently from the throttled one, and main-thread time at 1× can come out above 4×.
- Steadiest, on an otherwise quiet machine: JS bytes and request counts (exact), heap after GC (within about 1%), the `cold-load` timings (`ready`, FCP, LCP, main-thread time; a few %), and main-thread time of the stream scenarios on one machine and load (5–15%; more when something else runs). For a change under 15% in streaming main-thread time, take two reports per side, or raise `E2E_PERF_RUNS`.
- Long tasks, `frames.maxMs` and `frames.dropped` come from a few worst moments and swing between runs, more at 1× than at 4×; trust a change in them when it repeats across reports. `frames.p50Ms` and `p95Ms` sit at one frame unless the page is badly behind.
- `many-conversations-heap` shows what the client retains for conversations it has left (`heap.afterBytes` − `heap.beforeBytes`).
- Small values (TTFB on localhost, a few ms of layout, 0 → 1 long task) cross the threshold on noise.

## Caveats

- Headless Chromium draws at 60 Hz; frame metrics assume that rate.
- CPU throttling slows this machine's renderer; it doesn't model a phone. The mobile project is an emulated Pixel 7 (viewport, touch, user agent), not a device.
- The rAF loop that measures frames keeps the page drawing every frame, a constant cost included in every scenario.
- Every scenario blocks the service worker. On a first visit it would precache the whole build from the same server during the load, and serve some lazy chunks from its cache depending on timing, so load timings and JS bytes would vary from run to run. The regression `cold-load` spec covers its install. `cold-load` starts from the context's empty page: its `heap.beforeBytes` is that page's, and its main-thread times are the app document's from its commit (CDP's totals restart with each document).
- Static assets are served precompressed. Chromium only advertises brotli over HTTPS, so on this plain-HTTP localhost server the JS transfer size is the gzip size, larger than the brotli size production clients get.
- The stream scenarios' windows end in the first frame where the page shows no run (no live turn, no Working mark), checked every frame; the server's state is checked afterwards, outside the window. The server publishes a git refresh 2 s after a turn ends: `long-stream` and `tool-storm` end before it (unless the page lags that far behind), `multi-agent-review` waits for the review pane's refetch on it.
