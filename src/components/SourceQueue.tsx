import { useEffect, useMemo, useState } from "react";
import type { PullRequest } from "../types/pr";
import type { MergeRequest } from "../types/gitlab";
import type { PrIdentity } from "../types/identity";
import type { SourceCoverage } from "../api/tauri";
import type { SourceSelection } from "../store/sourceSelection";
import { useSourceSelection } from "../store/sourceSelection";
import { prIdentity, prKey } from "../lib/prIdentity";
import { current } from "../lib/ariaCurrent";
import { PrRow } from "./PrRow";
import { ViewSwitcher } from "./ViewSwitcher";
import { ExternalLink } from "./ExternalLink";
import { relativeSeconds } from "../lib/time";
import { useFilters } from "../store/filters";
import { useRowCursor } from "../lib/useRowCursor";
import { GitLabDetail } from "./GitLabDetail";
import { GitLabBulkActions } from "./GitLabBulkActions";

type Row = { kind: "github"; value: PullRequest } | { kind: "gitlab"; value: MergeRequest };

export function sourceRepoKey(row: PrIdentity): string {
  const source = row.source ?? { provider: "github", host: "github.com" };
  return JSON.stringify([source.provider, source.host, row.repo]);
}

export function combinedRows(github: PullRequest[], gitlab: MergeRequest[], selection: SourceSelection, repoKey: string | null, query: string): Row[] {
  const all: Row[] = [
    ...(selection === "gitlab" ? [] : github.map((value): Row => ({ kind: "github", value }))),
    ...(selection === "github" ? [] : gitlab.map((value): Row => ({ kind: "gitlab", value }))),
  ];
  const needle = query.toLowerCase().trim();
  return all.filter(({ value }) =>
    (repoKey === null || sourceRepoKey(value) === repoKey) &&
    (!needle || value.title.toLowerCase().includes(needle) || value.repo.toLowerCase().includes(needle) || String(value.number) === needle.replace(/^#|^!/, "")),
  ).sort((a, b) => Date.parse(b.value.created_at) - Date.parse(a.value.created_at) || prKey(a.value).localeCompare(prKey(b.value)));
}

function coverageMessage(provider: string, coverage: SourceCoverage | null, count: number): string | null {
  if (coverage === null || coverage === "unknown") return `${provider} could not confirm whether this list is complete.`;
  if (typeof coverage === "object") {
    const total = coverage.partial.total;
    return total !== null && total > count
      ? `${provider}: showing ${count} of ${total}; the rest did not load.`
      : `${provider}: this list is partial; more rows may be open.`;
  }
  return null;
}

export function SourceRepoSidebar({ github, gitlab, selection }: { github: PullRequest[]; gitlab: MergeRequest[]; selection: SourceSelection }) {
  const repoKey = useSourceSelection((s) => s.repoKey);
  const setRepoKey = useSourceSelection((s) => s.setRepoKey);
  const rows: Row[] = [
    ...(selection === "gitlab" ? [] : github.map((value): Row => ({ kind: "github", value }))),
    ...gitlab.map((value): Row => ({ kind: "gitlab", value })),
  ];
  const repos = new Map<string, { label: string; count: number }>();
  for (const { value } of rows) {
    const key = sourceRepoKey(value);
    const label = `${value.source?.provider === "gitlab" ? "GitLab" : "GitHub"} · ${value.source?.host ?? "github.com"} · ${value.repo}`;
    const prior = repos.get(key);
    repos.set(key, { label, count: (prior?.count ?? 0) + 1 });
  }
  return (
    <nav className="flex w-64 shrink-0 flex-col border-r border-[#30363d] p-3">
      <ViewSwitcher />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <button type="button" onClick={() => setRepoKey(null)} aria-current={current(repoKey === null)} className="flex w-full justify-between rounded px-3 py-2 text-sm hover:bg-[#161b22]">
          <span>All repositories</span><span>{rows.length} shown</span>
        </button>
        {[...repos].sort((a, b) => b[1].count - a[1].count).map(([key, repo]) => (
          <button type="button" key={key} onClick={() => setRepoKey(key)} aria-current={current(repoKey === key)} className="flex w-full justify-between gap-2 rounded px-3 py-2 text-left text-sm hover:bg-[#161b22]">
            <span className="truncate">{repo.label}</span><span>{repo.count} shown</span>
          </button>
        ))}
      </div>
    </nav>
  );
}

function GitLabRow({ mr, onOpen, opened, cursored }: { mr: MergeRequest; onOpen: () => void; opened: boolean; cursored: boolean }) {
  return (
    <div role="button" tabIndex={0} aria-current={current(opened)} onClick={onOpen} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }} className={`cursor-pointer border-b border-[#30363d] px-4 py-3 hover:bg-[#161b22] ${cursored ? "ring-2 ring-inset ring-[#1f6feb]" : ""}`}>
      <div className="text-xs text-[#8b949e]">GitLab · {mr.source.host} · {mr.repo}</div>
      <div className="mt-1 font-semibold">{mr.title} <span className="text-xs font-normal text-[#8b949e]">!{mr.number}</span></div>
      <div className="mt-1 text-xs text-[#8b949e]">
        {mr.is_draft ? "Draft · " : ""}{mr.author} · {mr.head_ref} → {mr.base_ref}
        {mr.ci === null ? " · CI not checked" : ` · CI ${mr.ci}`}
        {mr.review === null ? " · Review not checked" : ` · Review ${mr.review.replaceAll("_", " ")}`}
      </div>
      <ExternalLink href={mr.url} className="mt-1 inline-block text-xs text-[#4493f8] hover:underline">Open on GitLab</ExternalLink>
    </div>
  );
}

export function GitLabSummary({ mr, onBack }: { mr: MergeRequest | undefined; onBack: () => void }) {
  return (
    <div className="rounded-md border border-[#30363d] bg-[#161b22] p-4">
      <button type="button" onClick={onBack} className="mb-3 text-sm text-[#4493f8]">← Back to list</button>
      {mr ? <>
        <div className="text-xs text-[#8b949e]">GitLab · {mr.source.host} · {mr.repo} !{mr.number}</div>
        <h2 className="mt-1 text-lg font-semibold">{mr.title}</h2>
        <p className="mt-2 text-sm text-[#8b949e]">{mr.author} · {mr.head_ref} → {mr.base_ref}{mr.is_draft ? " · Draft" : ""}</p>
        <GitLabDetail key={prKey(mr)} identity={prIdentity(mr)} />
        <ExternalLink href={mr.url} className="mt-3 inline-block text-sm text-[#4493f8] hover:underline">Open on GitLab</ExternalLink>
      </> : <p className="text-sm text-[#8b949e]">This merge request is no longer in the saved list. Go back and refresh the queue.</p>}
    </div>
  );
}

export function SourceQueue({
  selection, github, gitlab, githubLoading, gitlabLoading, githubError, gitlabError,
  githubCoverage, gitlabCoverage, onOpen, onRefreshGitHub, onRefreshGitLab,
  githubStaleSecs, gitlabStaleSecs,
  canWriteGitHub,
}: {
  selection: SourceSelection;
  github: PullRequest[];
  gitlab: MergeRequest[] | undefined;
  githubLoading: boolean;
  gitlabLoading: boolean;
  githubError: string | null;
  gitlabError: string | null;
  githubCoverage: SourceCoverage | null;
  gitlabCoverage: SourceCoverage | null;
  githubStaleSecs: number | null;
  gitlabStaleSecs: number | null | "unknown";
  canWriteGitHub: boolean;
  onOpen: (identity: PrIdentity) => void;
  onRefreshGitHub: () => void;
  onRefreshGitLab: () => void;
}) {
  const repoKey = useSourceSelection((s) => s.repoKey);
  const query = useSourceSelection((s) => s.query);
  const setQuery = useSourceSelection((s) => s.setQuery);
  const [gitlabSelected, setGitlabSelected] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const selectedPr = useFilters((s) => s.selectedPr);
  const cursor = useFilters((s) => s.cursor);
  const setCursor = useFilters((s) => s.setCursor);
  const rows = useMemo(() => combinedRows(github, gitlab ?? [], selection, repoKey, query), [github, gitlab, selection, repoKey, query]);
  useRowCursor({
    rows: () => rows.length,
    open: (index) => {
      const row = rows[index];
      if (row) onOpen(prIdentity(row.value));
    },
  });
  useEffect(() => {
    if (cursor !== null && cursor >= rows.length) setCursor(rows.length > 0 ? rows.length - 1 : null);
  }, [cursor, rows.length, setCursor]);
  const sources = [
    ...(selection === "gitlab" ? [] : [{ name: "GitHub", rows: (githubLoading || githubError) && github.length === 0 ? undefined : github.length, loading: githubLoading, error: githubError, coverage: githubCoverage, staleSecs: githubStaleSecs, retry: onRefreshGitHub }]),
    { name: "GitLab", rows: gitlab?.length, loading: gitlabLoading, error: gitlabError, coverage: gitlabCoverage, staleSecs: gitlabStaleSecs, retry: onRefreshGitLab },
  ];
  return <div className="space-y-3">
    <p className="text-xs text-[#8b949e]">GitLab queues currently read GitLab.com. Self-managed hosts are not configured yet.</p>
    {sources.map((source) => <div key={source.name}>
      {source.error ? <div role="alert" className="rounded-md border border-[#d29922]/40 bg-[#d29922]/10 px-4 py-2 text-sm text-[#d29922]">
        {source.name}: {source.error}{source.rows !== undefined ? " Saved rows remain visible." : ""}
        <button type="button" onClick={source.retry} className="ml-2 underline">Retry</button>
      </div> : source.loading && source.rows === undefined ? <p role="status" className="text-sm text-[#8b949e]">Loading {source.name}…</p> : null}
      {source.rows !== undefined && source.coverage !== "complete" ? <p role="status" className="mt-1 text-xs text-[#d29922]">{coverageMessage(source.name, source.coverage, source.rows)}</p> : null}
      {source.rows !== undefined && source.staleSecs !== null ? <p role="status" className="mt-1 text-xs text-[#d29922]">{source.staleSecs === "unknown" ? `${source.name} saved list age could not be confirmed.` : `${source.name} is showing a saved list from ${relativeSeconds(source.staleSecs)}.`}</p> : null}
    </div>)}
    <label className="block text-xs text-[#8b949e]">Search pull and merge requests
      <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} className="mt-1 w-full rounded border border-[#30363d] bg-[#0d1117] px-3 py-2 text-sm text-[#e6edf3]" placeholder="Title, project, or number" />
    </label>
    <GitLabBulkActions rows={rows.flatMap((row) => row.kind === "gitlab" && gitlabSelected.has(prKey(row.value)) ? [row.value] : [])} onBusy={setBulkBusy} onSettled={() => { setGitlabSelected(new Set()); onRefreshGitLab(); }} />
    <div className="rounded-md border border-[#30363d]">
      <div className="border-b border-[#30363d] bg-[#161b22] px-4 py-3 text-sm font-semibold">{rows.length} shown</div>
      {rows.length === 0 ? <p className="px-4 py-10 text-center text-sm text-[#8b949e]">
        {sources.some((s) => s.rows === undefined)
          ? sources.some((s) => s.error) ? "Some sources could not be checked. No requests are available to show." : "Waiting for a source to answer…"
          : query || repoKey ? "No requests match this search or repository." : "No open requests were returned by the selected sources."}
      </p> : rows.map((row, index) => row.kind === "github"
        ? <PrRow key={prKey(row.value)} pr={row.value} onOpen={() => onOpen(prIdentity(row.value))} opened={selectedPr !== null && prKey(selectedPr) === prKey(row.value)} cursored={cursor === index} canWrite={canWriteGitHub} showSource />
        : <div key={prKey(row.value)} className="flex items-start">
          <input type="checkbox" className="ml-3 mt-4" aria-label={`Select GitLab ${row.value.source.host} ${row.value.repo} !${row.value.number}`} checked={gitlabSelected.has(prKey(row.value))} disabled={bulkBusy || (!gitlabSelected.has(prKey(row.value)) && gitlabSelected.size >= 10)} onChange={(event) => setGitlabSelected((previous) => { const next = new Set(previous); if (event.target.checked) next.add(prKey(row.value)); else next.delete(prKey(row.value)); return next; })} />
          <div className="min-w-0 flex-1"><GitLabRow mr={row.value} onOpen={() => onOpen(prIdentity(row.value))} opened={selectedPr !== null && prKey(selectedPr) === prKey(row.value)} cursored={cursor === index} /></div>
        </div>)}
    </div>
  </div>;
}
