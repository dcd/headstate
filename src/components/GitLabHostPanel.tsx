import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getGitLabHost, setGitLabHost } from "@/api/gitlabHost";

export function GitLabHostPanel() {
  const queryClient = useQueryClient();
  const host = useQuery({ queryKey: ["gitlab-host"], queryFn: getGitLabHost, retry: false });
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? host.data ?? "";
  const save = useMutation({
    mutationFn: setGitLabHost,
    onSuccess: (saved) => {
      setDraft(null);
      queryClient.setQueryData(["gitlab-host"], saved);
      // Purge receipts for the previous host, including stats keys where
      // "gitlab" is not the first segment. Keep the saved host query.
      queryClient.removeQueries({ predicate: ({ queryKey }) =>
        queryKey[0] !== "gitlab-host" && queryKey.some((part) => typeof part === "string" && part.startsWith("gitlab")),
      });
    },
  });

  return (
    <div className="mt-5 flex flex-col gap-2">
      <label htmlFor="gitlab-host" className="text-sm font-medium">GitLab host</label>
      <input
        id="gitlab-host"
        value={value}
        onChange={(event) => { setDraft(event.target.value); save.reset(); }}
        disabled={host.isPending || save.isPending}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        placeholder="gitlab.com"
        className="rounded border border-[#30363d] bg-[#0d1117] px-2 py-1 font-mono text-sm"
      />
      <p className="text-xs text-[#8b949e]">
        Enter a DNS hostname only. Headstate uses HTTPS and the desktop&apos;s
        glab login for this host. Run <code>glab auth login --hostname {host.data || "gitlab.com"}</code> on the desktop after saving.
      </p>
      {host.isError ? <p role="alert" className="text-xs text-[#f85149]">Could not load the saved GitLab host.</p> : null}
      {save.isError ? <p role="alert" className="text-xs text-[#f85149]">{String(save.error)}</p> : null}
      <button
        type="button"
        disabled={host.isPending || save.isPending || !draft || draft === host.data}
        onClick={() => save.mutate(value)}
        className="self-start rounded border border-[#30363d] px-3 py-1 text-sm disabled:opacity-50"
      >
        Save GitLab host
      </button>
    </div>
  );
}
