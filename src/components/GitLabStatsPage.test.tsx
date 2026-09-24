import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { GitLabStatsPage, GitLabStatsResults } from "./GitLabStatsPage";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { call } from "../api/transport";
import type { GitLabStatsReport } from "../api/gitlabStats";
vi.mock("../api/transport", () => ({ call: vi.fn() }));
function report(complete: boolean): GitLabStatsReport {
  return {
    source: { provider: "gitlab", host: "gitlab.com" }, viewer: "1", scope: { kind: "mine" },
    start: "2026-09-01T00:00:00Z", end: "2026-09-02T00:00:00Z", fetched_at: "2026-09-02T00:00:00Z",
    coverage: { complete, stop: complete ? "complete" : "rate_limited", pages: 1, received: 1, total: 2, rate_remaining: 0, rate_reset: null },
    counts: { created: 1, merged: 1, closed: 0, opened: 0 }, series: [{ day: "2026-09-01", created: 1 }],
    authors: [{ username: "author", created: 1, merged: 1, mean_merge_hours: 24, timed_merges: 1 }],
    reviewers: [{ username: "reviewer", assigned: 1 }], reviewer_rows_measured: 1, review_activity: null, history: [],
  };
}
describe("GitLab statistics evidence", () => {
  it("qualifies partial counts and suppresses a biased mean", () => {
    render(<GitLabStatsResults report={report(false)} />);
    expect(screen.getByRole("status").textContent).toContain("rate limited");
    expect(screen.getAllByText("At least 0")).toHaveLength(2);
    expect(screen.queryByText(/24.0 hours/)).toBeNull();
    expect(screen.getByText("Unavailable")).toBeTruthy();
    expect(screen.getByText(/Comment activity and response times unavailable/)).toBeTruthy();
  });
  it("renders a measured zero and a fully measured mean only for complete coverage", () => {
    render(<GitLabStatsResults report={report(true)} />);
    expect(screen.getAllByText("0")).toHaveLength(2);
    expect(screen.getByText("24.0 hours (1 MRs)")).toBeTruthy();
    expect(screen.queryByText("At least 0")).toBeNull();
  });
  it("withholds the mean when merged timestamps are missing", () => {
    const data = report(true); data.authors[0].timed_merges = 0; data.authors[0].mean_merge_hours = null;
    render(<GitLabStatsResults report={data} />);
    expect(screen.getByText("Unavailable")).toBeTruthy();
  });
});

function mountPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><GitLabStatsPage /></QueryClientProvider>);
  return client;
}
function tree(viewer: string, projects: string[], complete = true) {
  return { source: { provider: "gitlab", host: "gitlab.com" }, viewer,
    projects: projects.map(path => ({ path, namespace: "" })),
    coverage: { ...report(complete).coverage, complete } };
}
function accountReport(viewer: string) {
  const result = report(true);
  result.viewer = viewer;
  result.authors[0].username = `author-${viewer}`;
  return result;
}
describe("GitLab statistics account refresh", () => {
  beforeEach(() => vi.mocked(call).mockReset());

  it("rediscovers partial scopes and refreshes the same account's statistics", async () => {
    let discovery = 0;
    vi.mocked(call).mockImplementation(async (name) => {
      if (name === "gitlab_stats_tree") {
        discovery += 1;
        return tree("1", discovery === 1 ? ["one/project"] : ["one/project", "two/project"], discovery > 1);
      }
      return accountReport("1");
    });
    mountPage();
    await screen.findByText("author-1");
    expect(screen.getByText(/Project discovery is partial/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByRole("option", { name: "Project: two/project" });
    await screen.findByText("author-1");
    expect(screen.queryByText(/Project discovery is partial/)).toBeNull();
    expect(vi.mocked(call).mock.calls.filter(([name]) => name === "gitlab_stats_tree")).toHaveLength(2);
    expect(vi.mocked(call).mock.calls.filter(([name]) => name === "gitlab_stats_load")).toHaveLength(2);
  });

  it("clears account A's scopes and selected project when Refresh discovers account B", async () => {
    let viewer = "1";
    vi.mocked(call).mockImplementation(async (name) => name === "gitlab_stats_tree"
      ? tree(viewer, [`account-${viewer}/project`]) : accountReport(viewer));
    mountPage();
    await screen.findByText("author-1");
    fireEvent.change(screen.getByLabelText("GitLab statistics scope"), { target: { value: JSON.stringify({ kind: "project", path: "account-1/project" }) } });
    await waitFor(() => expect(vi.mocked(call).mock.calls.filter(([name]) => name === "gitlab_stats_load")).toHaveLength(2));
    viewer = "2";
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("author-2");
    expect(screen.queryByText("author-1")).toBeNull();
    expect(screen.queryByRole("option", { name: "Project: account-1/project" })).toBeNull();
    expect(screen.getByRole("option", { name: "Project: account-2/project" })).toBeTruthy();
    expect((screen.getByLabelText("GitLab statistics scope") as HTMLSelectElement).value).toBe(JSON.stringify({ kind: "mine" }));
    const loads = vi.mocked(call).mock.calls.filter(([name]) => name === "gitlab_stats_load");
    expect(loads.at(-1)?.[1]?.scope).toEqual({ kind: "mine" });
  });

  it("rejects a mid-request account switch without caching B under A and recovers through discovery", async () => {
    let discoveredViewer = "1";
    vi.mocked(call).mockImplementation(async (name) => name === "gitlab_stats_tree"
      ? tree(discoveredViewer, [`account-${discoveredViewer}/project`]) : accountReport("2"));
    const client = mountPage();
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain("account changed");
    expect(screen.queryByText("author-2")).toBeNull();
    expect(client.getQueryData(["stats", "gitlab", "gitlab.com", "1", { kind: "mine" }, 30])).toBeUndefined();
    discoveredViewer = "2";
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("author-2");
    expect(client.getQueryData<GitLabStatsReport>(["stats", "gitlab", "gitlab.com", "2", { kind: "mine" }, 30])?.viewer).toBe("2");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
