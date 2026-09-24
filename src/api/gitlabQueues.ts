import { useCallback, useEffect, useState } from "react";
import { listen } from "./transport";
import { getSourceSnapshot, refreshSelectedSource, type SourceCoverage, type SourceList } from "./tauri";
import type { MergeRequest } from "../types/gitlab";
import { safeUnlisten } from "./unlisten";

export const GITLAB_COM = { provider: "gitlab", host: "gitlab.com" } as const;

type QueueState = {
  rows: MergeRequest[] | undefined;
  coverage: SourceCoverage | null;
  staleSecs: number | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
};

const initial: QueueState = {
  rows: undefined, coverage: null, staleSecs: null,
  loading: true, refreshing: false, error: null,
};

type Update = {
  source: { provider: string; host: string };
  list: SourceList;
  phase: string;
  error: string | null;
  mrs?: MergeRequest[] | null;
  coverage?: SourceCoverage | null;
};

export function useGitLabQueue(list: SourceList, enabled: boolean) {
  const [state, setState] = useState<QueueState>(initial);
  const refresh = useCallback(async () => {
    if (!enabled) return;
    setState((s) => ({ ...s, refreshing: true }));
    try {
      const reply = await refreshSelectedSource(GITLAB_COM, list);
      if (reply.mrs !== null) {
        setState({ rows: reply.mrs, coverage: reply.coverage, staleSecs: null, loading: false, refreshing: false, error: null });
      } else {
        setState((s) => ({ ...s, loading: false, refreshing: false }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setState((s) => ({ ...s, loading: false, refreshing: false, error: message }));
    }
  }, [enabled, list]);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    getSourceSnapshot(GITLAB_COM, list).then((snapshot) => {
      if (!active) return;
      const data = snapshot.data;
      if (data.state === "git_lab_available") {
        setState((s) => ({ ...s, rows: data.mrs, coverage: data.coverage, staleSecs: data.stale_secs, loading: false }));
      } else if (data.state === "unreadable") {
        setState((s) => ({ ...s, loading: false, error: "The saved GitLab list could not be read." }));
      }
    }).catch(() => {
      // A paired phone may be away from its desktop. The live request below
      // supplies the actionable error; no empty list is inferred here.
    }).finally(() => { if (active) void refresh(); });
    const timer = window.setInterval(() => { void refresh(); }, 60_000);
    let unlisten: (() => void) | undefined;
    listen<Update>("source-poll-status", ({ payload }) => {
      if (payload.source.provider !== "gitlab" || payload.source.host !== "gitlab.com" || payload.list !== list) return;
      setState((s) => ({
        ...s,
        ...(payload.mrs != null ? { rows: payload.mrs, coverage: payload.coverage ?? null, staleSecs: null, loading: false } : {}),
        ...(payload.phase === "failed" || payload.phase === "not_asked" ? { error: payload.error, loading: false, refreshing: false } : {}),
      }));
    }).then((fn) => { if (active) unlisten = fn; else safeUnlisten(fn); }, () => {});
    listen("refresh-requested", () => { void refresh(); }).then((fn) => { if (active) {
      const prior = unlisten;
      unlisten = () => { safeUnlisten(prior); safeUnlisten(fn); };
    } else safeUnlisten(fn); }, () => {});
    return () => { active = false; window.clearInterval(timer); safeUnlisten(unlisten); };
  }, [enabled, list, refresh]);

  return { ...state, refresh };
}
