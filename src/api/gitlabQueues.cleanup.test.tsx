import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => {
  const listeners: Array<{ event: string; handler: (event: { payload: unknown }) => void; resolve: (unlisten: () => void) => void }> = [];
  return { listeners, unlisten: vi.fn(), refresh: vi.fn(), snapshot: vi.fn() };
});
vi.mock("./transport", () => ({
  listen: (event: string, handler: (event: { payload: unknown }) => void) =>
    new Promise<() => void>((resolve) => ipc.listeners.push({ event, handler, resolve })),
}));
vi.mock("./tauri", () => ({
  getSourceSnapshot: ipc.snapshot,
  refreshSelectedSource: ipc.refresh,
}));

import { useGitLabQueue } from "./gitlabQueues";

afterEach(() => {
  ipc.listeners.length = 0;
  ipc.unlisten.mockReset();
  ipc.refresh.mockReset();
  ipc.snapshot.mockReset();
});

describe("GitLab queue listeners", () => {
  it("unregisters listeners whose registration finishes after deselection", async () => {
    ipc.snapshot.mockReturnValue(new Promise(() => {}));
    const { unmount } = renderHook(() => useGitLabQueue("authored", true));
    expect(ipc.listeners.map(({ event }) => event)).toEqual(["source-poll-status", "refresh-requested"]);
    unmount();
    await act(async () => {
      for (const listener of ipc.listeners) listener.resolve(ipc.unlisten);
      await Promise.resolve();
    });
    expect(ipc.unlisten).toHaveBeenCalledTimes(2);
    ipc.listeners.find(({ event }) => event === "refresh-requested")?.handler({ payload: null });
    expect(ipc.refresh).toHaveBeenCalledTimes(0);
  });
});
