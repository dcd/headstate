import type { GitLabQueueSnapshot } from "../api/gitlabQueueState";
import { relativeSeconds } from "./time";

/** Describe the accepted GitLab receipt, never a GitHub cache timestamp. */
export function gitlabQueueSummary(queue?: GitLabQueueSnapshot): { text: string; warning: boolean } {
  if (!queue) return { text: "GitLab MR status unavailable", warning: true };
  if (queue.rows === undefined) return {
    text: queue.error ? "GitLab MRs: could not refresh" : queue.loading || queue.refreshing ? "Checking GitLab MRs…" : "GitLab MR status unavailable",
    warning: true,
  };
  const freshness = typeof queue.staleSecs === "number"
    ? `updated ${relativeSeconds(queue.staleSecs)}` : "freshness unavailable";
  const coverage = queue.coverage === "complete" ? "" : typeof queue.coverage === "object" && queue.coverage !== null
    ? " · partial list" : " · completeness unknown";
  const progress = queue.error ? " · refresh failed" : queue.refreshing ? " · refreshing" : "";
  return {
    text: `GitLab MRs ${freshness}${coverage}${progress}`,
    warning: !!queue.error || queue.coverage !== "complete" || typeof queue.staleSecs !== "number",
  };
}
