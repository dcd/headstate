import { useState } from "react";
import { StatsPage } from "./StatsPage";
import { GitLabStatsPage } from "./GitLabStatsPage";

/** Provider pages never share queries, scope selection, or totals. */
export function ProviderStatsPage({ selection = "github" }: { selection?: "github" | "gitlab" | "both" }) {
  const [tab, setTab] = useState<"github" | "gitlab">("github");
  const provider = selection === "both" ? tab : selection;
  return <div className="flex min-h-0 flex-1 flex-col">
    {selection === "both" && <div className="flex gap-2 border-b p-2" aria-label="Statistics provider">{(["github", "gitlab"] as const).map(p => <button type="button" key={p} aria-pressed={provider === p} onClick={() => setTab(p)} className="rounded border px-3 py-1">{p === "github" ? "GitHub PR Stats" : "GitLab MR Stats"}</button>)}</div>}
    {provider === "github" ? <StatsPage /> : <GitLabStatsPage />}
  </div>;
}
