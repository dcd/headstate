import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { GitLabCapabilities, GitLabDetail as Detail } from "../types/gitlabActions";
import type { MergeRequest } from "../types/gitlab";
import { GitLabDetail } from "./GitLabDetail";
import { GitLabBulkActions } from "./GitLabBulkActions";
import { getGitLabActionCapabilities, getGitLabDetail, gitLabAction } from "../api/tauri";

vi.mock("../api/tauri", () => ({ getGitLabActionCapabilities: vi.fn(), getGitLabDetail: vi.fn(), gitLabAction: vi.fn() }));
vi.mock("./ExternalLink", () => ({ ExternalLink: ({ children }: { children: ReactNode }) => <span>{children}</span> }));

const identity = { source: { provider: "gitlab" as const, host: "gitlab.com" }, repo: "group/subgroup/project", number: 7 };
const capabilities: GitLabCapabilities = {
  identity, head_oid: "head-7", actions: [{ action: "close", allowed: true, reason: null }, { action: "comment", allowed: true, reason: null }, { action: "merge", allowed: false, reason: "Not mergeable" }],
  discussions: [], discussions_complete: true,
};
const detail: Detail = {
  core: { identity, id: 77, title: "A change", url: "https://gitlab.com/group/subgroup/project/-/merge_requests/7", state: "opened", is_draft: true, body: null, author: "person", head_ref: "topic", head_oid: "head-7", base_ref: "main", detailed_merge_status: "draft_status", blocking_discussions_resolved: null },
  pipelines: { pipelines: { state: "available", value: { items: [], total: 0, coverage: "complete" } }, current_head_jobs: null },
  approvals: { state: "unavailable", issue: "forbidden" }, approval_rules: { state: "unavailable", issue: "forbidden" },
  comments: { state: "available", value: { items: [], total: 0, coverage: "complete" } },
  discussions: { state: "available", value: { discussions: { items: [], total: 0, coverage: "complete" }, unresolved_resolvable: 0 } },
};

function wrap(children: ReactNode) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>{children}</QueryClientProvider>);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getGitLabActionCapabilities).mockResolvedValue(capabilities);
  vi.mocked(getGitLabDetail).mockResolvedValue(detail);
  vi.mocked(gitLabAction).mockResolvedValue({ identity, action: "close", outcome: "verified", message: "GitLab action verified." });
});

describe("GitLab actions", () => {
  it("routes the exact provider/host/project/IID and displayed head after confirmation", async () => {
    wrap(<GitLabDetail identity={identity} />);
    fireEvent.click(await screen.findByRole("button", { name: "Close MR" }));
    expect(gitLabAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(gitLabAction).toHaveBeenCalledExactlyOnceWith({ identity, action: "close", expected_head: "head-7", body: undefined, discussion_id: undefined }));
    expect(await screen.findByText("Close MR: GitLab action verified.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Merge MR" })).toBeNull();
  });

  it("shows an unverified write without success or automatic retry", async () => {
    vi.mocked(gitLabAction).mockResolvedValue({ identity, action: "close", outcome: "unverified", message: "The action may have applied. Refresh before trying again." });
    wrap(<GitLabDetail identity={identity} />);
    fireEvent.click(await screen.findByRole("button", { name: "Close MR" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect((await screen.findByRole("alert")).textContent).toContain("may have applied");
    expect(gitLabAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Close MR: GitLab action verified.")).toBeNull();
  });

  it("suppresses writes when permission and detail heads or hosts disagree", async () => {
    vi.mocked(getGitLabActionCapabilities).mockResolvedValue({ ...capabilities, identity: { ...identity, source: { provider: "gitlab", host: "other.example" } } });
    const view = wrap(<GitLabDetail identity={identity} />);
    await screen.findByText(/Action permissions and MR head/);
    expect(screen.queryByRole("button", { name: "Close MR" })).toBeNull();
    view.unmount();
    vi.mocked(getGitLabActionCapabilities).mockResolvedValue({ ...capabilities, head_oid: "new-head" });
    wrap(<GitLabDetail identity={identity} />);
    await screen.findByText(/Action permissions and MR head/);
    expect(screen.queryByRole("button", { name: "Close MR" })).toBeNull();
  });

  it("keeps missing approval and CI measurements explicit", async () => {
    wrap(<GitLabDetail identity={identity} />);
    expect(await screen.findByText("Approvals unavailable (forbidden).")).toBeTruthy();
    expect(screen.getByText("No pipelines returned. CI success has not been established.")).toBeTruthy();
    expect(screen.getByText("Current-head jobs were not checked.")).toBeTruthy();
  });

  it("retains per-identity bulk results and clears uncertain writes rather than retrying them", async () => {
    const other = { ...identity, number: 8 };
    const rows = [{ ...identity, head_oid: "head-7" }, { ...other, head_oid: "head-8" }] as MergeRequest[];
    vi.mocked(getGitLabActionCapabilities).mockImplementation(async (requested) => ({ ...capabilities, identity: requested, head_oid: `head-${requested.number}` }));
    vi.mocked(gitLabAction).mockImplementation(async (request) => ({ identity: request.identity, action: request.action, outcome: request.identity.number === 7 ? "verified" : "unverified", message: "receipt" }));
    const settled = vi.fn();
    wrap(<GitLabBulkActions rows={rows} onSettled={settled} onBusy={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Close MRs" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
    expect(gitLabAction).toHaveBeenNthCalledWith(1, { identity, action: "close", expected_head: "head-7" });
    expect(gitLabAction).toHaveBeenNthCalledWith(2, { identity: other, action: "close", expected_head: "head-8" });
    expect(screen.getByText(/!7: verified/)).toBeTruthy();
    expect(screen.getByText(/!8: could not verify/)).toBeTruthy();
    expect(gitLabAction).toHaveBeenCalledTimes(2);
  });

  it("offers no bulk action when one permission read fails", async () => {
    vi.mocked(getGitLabActionCapabilities).mockRejectedValue("Forbidden");
    wrap(<GitLabBulkActions rows={[{ ...identity, head_oid: "head-7" }] as MergeRequest[]} onSettled={vi.fn()} onBusy={vi.fn()} />);
    await screen.findByText(/Permissions and selected MR heads/);
    expect(screen.queryByRole("button", { name: "Close MRs" })).toBeNull();
    expect(gitLabAction).not.toHaveBeenCalled();
  });
});
