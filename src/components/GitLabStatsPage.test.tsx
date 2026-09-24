import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { GitLabStatsResults } from "./GitLabStatsPage";
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
    expect(screen.getByText(/Review activity and response times are unavailable/)).toBeTruthy();
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
