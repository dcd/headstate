import { describe, expect, it, vi } from "vitest";
import { GitLabQueueState, receiptAge } from "./gitlabQueueState";
import type { SourcePollUpdate } from "./tauri";
import type { MergeRequest } from "../types/gitlab";

const mr = (title: string) => ({
  source: { provider: "gitlab", host: "gitlab.com" }, repo: "group/project",
  number: 7, title,
} as MergeRequest);

function update(fields: Partial<SourcePollUpdate> = {}): SourcePollUpdate {
  return {
    source: { provider: "gitlab", host: "gitlab.com" }, list: "authored",
    phase: "ready", error: null, session: "desktop-1", revision: 1,
    receipt_revision: 1, completed_request: null,
    last_received_at: new Date().toISOString(), mrs: [mr("first")], coverage: "complete",
    ...fields,
  };
}

describe("GitLab queue reconciliation", () => {
  it("keeps a newer failure when an older successful fetch publishes usable rows", () => {
    const state = new GitLabQueueState();
    const older = state.start("older");
    state.start("newer");
    state.accept(update({ phase: "failed", error: "GitLab timed out", revision: 3, receipt_revision: null, mrs: null, completed_request: "newer" }));
    state.accept(update({ phase: "failed", error: "GitLab timed out", revision: 4, receipt_revision: 4, mrs: [mr("older result")], completed_request: "older" }));
    state.resolve(older, { request_id: "older", update: update({ phase: "ready", error: null, revision: 2, receipt_revision: 2 }) });
    expect(state.snapshot().rows?.[0].title).toBe("older result");
    expect(state.snapshot().error).toBe("GitLab timed out");
  });

  it("ignores a delayed older reply after a newer receipt and failure", () => {
    const state = new GitLabQueueState();
    const older = state.start("older");
    state.start("newer");
    state.accept(update({ revision: 5, receipt_revision: 5, mrs: [mr("newer result")], completed_request: "newer" }));
    state.accept(update({ phase: "failed", error: "GitLab rate limited", revision: 6, receipt_revision: 5, mrs: [mr("newer result")] }));
    state.resolve(older, { request_id: "older", update: update({ revision: 3, receipt_revision: 3, mrs: [mr("older result")], completed_request: "older" }) });
    expect(state.snapshot().rows?.[0].title).toBe("newer result");
    expect(state.snapshot().error).toBe("GitLab rate limited");
  });

  it("retains saved age when status repeats rows and clears it only for a fresh receipt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
    try {
      const state = new GitLabQueueState();
      state.seed({ state: "git_lab_available", mrs: [mr("saved")], coverage: "unknown", fetched_at: "2026-09-24 10:00:00", stale_secs: 7200 });
      state.accept(update({ revision: 1, receipt_revision: 1, mrs: [mr("saved")], last_received_at: "2026-09-24T10:00:00Z" }));
      expect(state.snapshot().staleSecs).toBe(7200);
      state.accept(update({ phase: "failed", error: "offline", revision: 2, receipt_revision: 1, mrs: [mr("saved")], last_received_at: "2026-09-24T10:00:00Z" }));
      expect(state.snapshot().staleSecs).toBe(7200);
      state.accept(update({ revision: 3, receipt_revision: 3, mrs: [mr("fresh")], last_received_at: "2026-09-24T12:00:00Z" }));
      expect(state.snapshot().staleSecs).toBeNull();
      expect(state.snapshot().error).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps unknown receipt age unknown", () => {
    expect(receiptAge(null)).toBe("unknown");
    expect(receiptAge("unreadable")).toBe("unknown");
  });
});
