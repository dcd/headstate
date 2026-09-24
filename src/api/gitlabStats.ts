import { useQuery } from "@tanstack/react-query";
import { call } from "./transport";
import type { Source } from "../types/identity";

export type GitLabScope = { kind: "mine" } | { kind: "project" | "group"; path: string };
interface Coverage {
  complete: boolean;
  stop: string;
  pages: number;
  received: number;
  total: number | null;
  rate_remaining: number | null;
  rate_reset: number | null;
}
interface Tree {
  source: Source;
  viewer: string;
  projects: { path: string; namespace: string }[];
  coverage: Coverage;
}
export interface GitLabStatsReport {
  source: Source;
  viewer: string;
  scope: GitLabScope;
  start: string;
  end: string;
  fetched_at: string;
  coverage: Coverage;
  counts: { created: number; merged: number; closed: number; opened: number };
  series: { day: string; created: number }[];
  authors: { username: string; created: number; merged: number; mean_merge_hours: number | null; timed_merges: number }[];
  reviewers: { username: string; assigned: number }[];
  reviewer_rows_measured: number;
  review_activity: number | null;
  history: { source: Source; project: string; iid: number; title: string; url: string; author: string; state: string; created_at: string; merged_at: string | null }[];
}
export function useGitLabStatsTree(host: string, revision: number) {
  return useQuery({ queryKey: ["stats", "gitlab", host, "tree", revision], queryFn: () => call<Tree>("gitlab_stats_tree", { host }), staleTime: 0, gcTime: 0, retry: false });
}
export function useGitLabStats(host: string, viewer: string | undefined, scope: GitLabScope, days: number) {
  return useQuery({
    queryKey: ["stats", "gitlab", host, viewer, scope, days],
    queryFn: async () => {
      const report = await call<GitLabStatsReport>("gitlab_stats_load", { host, scope, days, refresh: true });
      // glab credentials can change between discovery and this request. Never
      // put the new account's result into the previous account's query key.
      if (report.viewer !== viewer || report.source.provider !== "gitlab" || report.source.host !== host) {
        throw new Error("GitLab account changed while loading statistics. Refresh to reload the account and scopes.");
      }
      return report;
    },
    enabled: viewer !== undefined, staleTime: 0, gcTime: 0, retry: false,
  });
}
