import { useCallback, useEffect, useState } from "react";
import { listen, type UnlistenFn } from "./transport";
import { getSourceSnapshot, refreshSelectedSource, type SourceList, type SourcePollUpdate } from "./tauri";
import { GitLabQueueState } from "./gitlabQueueState";
import { safeUnlisten } from "./unlisten";
import { IS_MOBILE_BUILD } from "../lib/target";

const GITLAB_COM = { provider: "gitlab", host: "gitlab.com" } as const;

export function useGitLabQueue(list: SourceList, enabled: boolean) {
  const [model] = useState(() => new GitLabQueueState());
  const [state, setState] = useState(() => model.snapshot());
  const publish = useCallback(() => setState(model.snapshot()), [model]);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const request = model.start(crypto.randomUUID());
    publish();
    try {
      const reply = await refreshSelectedSource(GITLAB_COM, list, request.id);
      model.resolve(request, reply);
    } catch (error) {
      model.reject(request, error);
    }
    publish();
  }, [enabled, list, model, publish]);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const unlisteners: UnlistenFn[] = [];
    const register = (pending: Promise<UnlistenFn>) => {
      pending.then((fn) => { if (active) unlisteners.push(fn); else safeUnlisten(fn); }, () => {});
    };
    register(listen<SourcePollUpdate>("source-poll-status", ({ payload }) => {
      if (!active || payload.source.provider !== "gitlab" || payload.source.host !== "gitlab.com" || payload.list !== list) return;
      model.accept(payload);
      publish();
    }));
    register(listen("refresh-requested", () => { if (active) void refresh(); }));

    getSourceSnapshot(GITLAB_COM, list).then((snapshot) => {
      if (!active) return;
      model.seed(snapshot.data);
      publish();
    }).catch(() => {
      // The live request supplies the actionable failure. A disconnected
      // phone must not turn a cache read failure into a measured empty list.
    }).finally(() => { if (active) void refresh(); });

    const timer = window.setInterval(() => {
      if (!active) return;
      model.tick();
      publish();
      if (IS_MOBILE_BUILD) void refresh();
    }, 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
      for (const unlisten of unlisteners) safeUnlisten(unlisten);
    };
  }, [enabled, list, model, publish, refresh]);

  return { ...state, refresh };
}
