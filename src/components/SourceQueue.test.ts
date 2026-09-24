import { describe, expect, it } from "vitest";
import { combinedRows, sourceRepoKey } from "./SourceQueue";
import type { PullRequest } from "../types/pr";
import type { MergeRequest } from "../types/gitlab";

const gh = {
  source: { provider: "github", host: "github.com" },
  repo: "group/project", number: 7, title: "Same number", created_at: "2026-09-21T00:00:00Z",
} as PullRequest;
const gl = {
  source: { provider: "gitlab", host: "gitlab.com" },
  repo: "group/project", number: 7, title: "Same number", created_at: "2026-09-22T00:00:00Z",
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
});
