import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDuration, formatSeconds } from "./time";
import { useElapsed } from "./use-elapsed";

afterEach(() => {
  vi.useRealTimers();
});

describe("formatDuration", () => {
  it.each([
    [12, "12ms"],
    [999.4, "999ms"],
    [999.6, "1.0s"],
    [1234, "1.2s"],
    [59_949, "59.9s"],
    [59_950, "1m 0s"],
    [64_000, "1m 4s"],
    [-5, "0ms"],
  ])("%d ms → %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe("formatSeconds", () => {
  it.each([
    [0, "1s"],
    [400, "1s"],
    [12_400, "12s"],
    [59_499, "59s"],
    [59_500, "1m 0s"],
    [64_000, "1m 4s"],
    [3_725_000, "62m 5s"],
  ])("%d ms → %s", (ms, expected) => {
    expect(formatSeconds(ms)).toBe(expected);
  });
});

describe("useElapsed", () => {
  it("counts from startedAt every second; undefined without it", () => {
    vi.useFakeTimers({ now: 10_000 });
    const { result, rerender } = renderHook(({ at }) => useElapsed(at), {
      initialProps: { at: 7_000 as number | undefined },
    });
    expect(result.current).toBe(3_000);
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(4_000);
    rerender({ at: undefined });
    expect(result.current).toBeUndefined();
  });

  it("clamps at 0 when startedAt is ahead of the device's clock", () => {
    vi.useFakeTimers({ now: 10_000 });
    const { result } = renderHook(() => useElapsed(12_500));
    expect(result.current).toBe(0);
    act(() => vi.advanceTimersByTime(3000));
    expect(result.current).toBe(500);
  });
});
