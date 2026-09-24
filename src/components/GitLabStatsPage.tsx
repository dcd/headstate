import { useState } from "react";
import { useGitLabStats, useGitLabStatsTree, type GitLabScope, type GitLabStatsReport } from "../api/gitlabStats";

function qualified(n: number, complete: boolean) { return complete ? String(n) : `At least ${n}`; }

export function GitLabStatsResults({ report }: { report: GitLabStatsReport }) {
  const complete = report.coverage.complete;
  const assignmentsComplete = complete && report.reviewer_rows_measured === report.counts.created;
  return <div className="space-y-6">
    <p className="text-sm text-muted-foreground">MRs created {report.start.slice(0, 10)} through {report.end.slice(0, 10)} (UTC). Merged and closed counts describe this created cohort. Snapshot {new Date(report.fetched_at).toLocaleString()}.</p>
    {!complete && <p role="status" className="text-sm text-amber-600">Partial GitLab data: {report.coverage.stop.replaceAll("_", " ")}. {report.coverage.received} MRs retrieved{report.coverage.total === null ? "" : ` of ${report.coverage.total}`}. Counts are lower bounds; averages are withheld.</p>}
    {report.coverage.rate_remaining !== null && <p className="text-sm text-muted-foreground">GitLab requests remaining: {report.coverage.rate_remaining}{report.coverage.rate_reset === null ? "" : `; reset ${new Date(report.coverage.rate_reset * 1000).toLocaleString()}`}</p>}
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">{Object.entries(report.counts).map(([name, count]) => <div key={name}><dt className="capitalize text-sm">{name}</dt><dd className="text-xl font-semibold">{qualified(count, complete)}</dd></div>)}</dl>
    <section><h2 className="font-semibold">Created per day</h2><div className="max-h-64 overflow-auto"><table className="w-full text-left text-sm"><thead><tr><th>Date (UTC)</th><th>Created</th></tr></thead><tbody>{report.series.map(day => <tr key={day.day}><td>{day.day}</td><td>{qualified(day.created, complete)}</td></tr>)}</tbody></table></div></section>
    <section><h2 className="font-semibold">Authors in retrieved MRs</h2><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th>Author</th><th>Created</th><th>Merged</th><th>Mean time to merge</th></tr></thead><tbody>{report.authors.map(author => <tr key={author.username}><td>{author.username}</td><td>{qualified(author.created, complete)}</td><td>{qualified(author.merged, complete)}</td><td>{complete && author.mean_merge_hours !== null && author.timed_merges === author.merged ? `${author.mean_merge_hours.toFixed(1)} hours (${author.timed_merges} MRs)` : "Unavailable"}</td></tr>)}</tbody></table></div></section>
    <section><h2 className="font-semibold">Current reviewer assignments</h2><p className="text-sm text-muted-foreground">Reviewer lists measured for {report.reviewer_rows_measured} of {report.counts.created} retrieved MRs. Review activity and response times are unavailable from this read.</p><ul className="text-sm">{report.reviewers.map(reviewer => <li key={reviewer.username}>{reviewer.username}: {qualified(reviewer.assigned, assignmentsComplete)} assigned</li>)}</ul></section>
    <section><h2 className="font-semibold">MR history in this window</h2><ul className="space-y-2 text-sm">{report.history.map(mr => <li key={JSON.stringify([mr.source.provider, mr.source.host, mr.project, mr.iid])}><span className="font-medium">{mr.project}!{mr.iid}</span> — {mr.title} <span className="text-muted-foreground">({mr.state}; {mr.source.host})</span></li>)}</ul></section>
  </div>;
}

export function GitLabStatsPage({ host = "gitlab.com" }: { host?: string }) {
  const [selection, setSelection] = useState<{ account: string; scope: GitLabScope }>();
  const [days, setDays] = useState(30);
  const [revision, setRevision] = useState(0);
  const tree = useGitLabStatsTree(host, revision);
  const account = JSON.stringify([host, tree.data?.viewer]);
  const scope: GitLabScope = selection?.account === account ? selection.scope : { kind: "mine" };
  return <main className="mx-auto w-full max-w-5xl space-y-5 overflow-auto p-4 sm:p-6">
    <h1 className="text-xl font-semibold">GitLab MR Stats · {host}</h1>
    <button type="button" disabled={tree.isFetching} onClick={() => setRevision(value => value + 1)} className="rounded border px-2">Refresh</button>
    {tree.isFetching && <p role="status">Loading GitLab scopes…</p>}
    {tree.isError && <p role="alert">Could not load GitLab scopes: {String(tree.error)}</p>}
    {/* Refresh always rediscovers the account and retries partial discovery.
        Unmount statistics while discovery runs, so old scopes/results cannot
        launch requests or remain visible against a newly selected account. */}
    {tree.isSuccess && !tree.isFetching && <GitLabStatsScope key={JSON.stringify([account, revision])}
      host={host} tree={tree.data} scope={scope} days={days} setDays={setDays}
      setScope={next => setSelection({ account, scope: next })} />}
  </main>;
}

function GitLabStatsScope({ host, tree, scope, days, setScope, setDays }: {
  host: string;
  tree: NonNullable<ReturnType<typeof useGitLabStatsTree>["data"]>;
  scope: GitLabScope;
  days: number;
  setScope: (scope: GitLabScope) => void;
  setDays: (days: number) => void;
}) {
  const stats = useGitLabStats(host, tree.viewer, scope, days);
  const groups = [...new Set(tree.projects.map(p => p.namespace).filter(Boolean))];
  return <>
    <div className="flex flex-wrap gap-3">
      <label>Scope <select aria-label="GitLab statistics scope" value={JSON.stringify(scope)} onChange={e => setScope(JSON.parse(e.target.value) as GitLabScope)} className="rounded border bg-background p-1">
        <option value={JSON.stringify({ kind: "mine" })}>My authored MRs</option>
        {groups.map(path => <option key={`group:${path}`} value={JSON.stringify({ kind: "group", path })}>Group: {path}</option>)}
        {tree.projects.map(p => <option key={p.path} value={JSON.stringify({ kind: "project", path: p.path })}>Project: {p.path}</option>)}
      </select></label>
      <label>Window <select aria-label="GitLab statistics window" value={days} onChange={e => setDays(Number(e.target.value))} className="rounded border bg-background p-1"><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option></select></label>
    </div>
    {!tree.coverage.complete && <p role="status">Project discovery is partial ({tree.coverage.stop.replaceAll("_", " ")}); more scopes may exist.</p>}
    {stats.isPending && <p role="status">Loading GitLab statistics…</p>}
    {stats.isError && <p role="alert">Could not load GitLab statistics: {String(stats.error)}</p>}
    {stats.data && !stats.isError && <GitLabStatsResults report={stats.data} />}
  </>;
}
