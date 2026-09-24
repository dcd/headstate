import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SourceQueue, combinedRows, sourceRepoKey } from "./SourceQueue";
import type { PullRequest } from "../types/pr";
import type { MergeRequest } from "../types/gitlab";
import { activeRowCursor, resetRowCursorForTest } from "../lib/rowCursor";
import { useSourceSelection } from "../store/sourceSelection";
import { useFilters } from "../store/filters";
import { PR_FIXTURES } from "../fixtures/prs";

const gh = {
  source: { provider: "github", host: "github.com" },
  repo: "group/project", number: 7, title: "Same number", created_at: "2026-09-21T00:00:00Z",
} as PullRequest;
const gl = {
  source: { provider: "gitlab", host: "gitlab.com" },
  repo: "group/project", number: 7, title: "Same number", created_at: "2026-09-22T00:00:00Z",
  ci: null, review: null,
} as MergeRequest;
const selfManaged = {
  ...gl, source: { provider: "gitlab" as const, host: "gitlab.example" },
} as MergeRequest;

describe("source queue identity", () => {
  it("keeps overlapping project paths and numbers distinct across providers and hosts", () => {
    expect(new Set([sourceRepoKey(gh), sourceRepoKey(gl), sourceRepoKey(selfManaged)]).size).toBe(3);
    expect(combinedRows([gh], [gl], "both", null, "").map(({ value }) => value.source?.provider)).toEqual(["gitlab", "github"]);
    expect(combinedRows([gh], [gl], "both", sourceRepoKey(gl), "").map(({ value }) => value.source?.provider)).toEqual(["gitlab"]);
  });

  it("selects the requested provider and searches without borrowing the other source", () => {
    expect(combinedRows([gh], [gl], "github", null, "!7")).toEqual([{ kind: "github", value: gh }]);
    expect(combinedRows([gh], [gl], "gitlab", null, "#7")).toEqual([{ kind: "gitlab", value: gl }]);
    expect(combinedRows([gh], [gl], "both", null, "absent")).toEqual([]);
  });

  it("registers the rendered mixed rows for keyboard navigation", () => {
    resetRowCursorForTest();
    useSourceSelection.setState({ selection: "both", repoKey: null, query: "" });
    useFilters.setState({ cursor: null, selectedPr: null });
    const open = vi.fn();
    const view = render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(SourceQueue, {
      selection: "both", github: [{ ...PR_FIXTURES[0], ...gh }], gitlab: [gl], githubLoading: false,
      gitlabLoading: false, githubError: null, gitlabError: null,
      githubCoverage: "complete", gitlabCoverage: "complete",
      githubStaleSecs: null, gitlabStaleSecs: null, canWriteGitHub: true,
      onOpen: open, onRefreshGitHub: vi.fn(), onRefreshGitLab: vi.fn(),
    })));
    expect(activeRowCursor()?.rows()).toBe(2);
    activeRowCursor()?.open(0);
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ source: { provider: "gitlab", host: "gitlab.com" }, number: 7 }));
    expect(activeRowCursor()?.toggle).toBeUndefined();
    view.unmount();
    expect(activeRowCursor()).toBeNull();
  });
});
