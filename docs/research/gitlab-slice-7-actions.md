# GitLab slice 7: permission checks and verified actions

Author: Astra / high. GitLab.com remains the supported host; self-managed
hosts are refused before invoking the CLI. Every command carries the full
provider, host, project path and MR IID, including desktop and phone requests.
GitLab actions have their own command surface and cannot fall through to a
GitHub mutation. Credentials remain owned by `glab` on the desktop.

## Permission and write contract

Before each write, the adapter reads the exact MR and its GraphQL permissions.
The REST IID/URL and GraphQL IID/URL/head must agree with the requested identity.
Approval additionally requires the REST `user_can_approve` flag and refuses
known reauthentication requirements. Discussion resolution checks each
discussion's `resolveNote` permission; retry CI checks the current-head
pipeline's `retryable` and `updatePipeline` flags. Pipeline writes use the
pipeline's project ID, including fork pipelines.

The UI offers approve, comment, discussion reply/resolve/reopen, merge,
close/reopen, draft/ready, source-branch rebase, retry CI and supported
auto-merge only when the fetched permission receipt allows them. Merge
requires the raw detailed status `mergeable`. Merge trains and GitHub
request-changes reviews are explained as unsupported. Auto-merge requires
GitLab to advertise `merge_when_checks_pass`; a merge train strategy alone
does not enable it. Approval, merge and auto-merge send the displayed head SHA
to GitLab. Rebase and CI retry recheck that head before issuing their write;
GitLab's rebase endpoint has no atomic head guard, which the confirmation names.

Every supported action has a separate readback. Approval checks the current
user's approval and head; comments/replies check the returned note ID and body;
resolution checks the requested thread's resolvable notes; state changes read
the MR again; retry checks the current pipeline's identity, head and active
status; auto-merge reads its enabled flag. Rebase polls at most three times and
requires a changed head matching GitLab's `rebaseCommitSha` after completion.

A successful HTTP status alone never yields `verified`. A write timeout,
refusal, failed readback or operation still pending yields `unverified`, with
instructions to refresh before acting again. The app never automatically
retries a write. Text goes through CLI stdin, not process arguments; comments
beginning with slash commands are refused so GitLab quick actions cannot
bypass the dedicated action gates.

## Bounds and bulk behavior

Each action has a 60-second budget; each subprocess is limited to 15 seconds
and 4 MiB of output and is killed on cancellation. The permissions read asks
for at most 100 discussions. Later discussions are explicitly left for
GitLab's UI. Comment input is capped at 32 KiB.

Bulk selection uses complete identities and is separate from GitHub selection.
It accepts at most ten GitLab rows and offers approve, close, draft and ready
only when all selected rows have matching permission/head receipts. The
confirmation enumerates host, project and IID. Each row is rechecked at write
time, requests run sequentially, and results are retained separately. All
attempted rows are deselected afterwards because an uncertain write may have
landed. Merge, auto-merge and rebase are not bulk actions.

## Evidence and limitations

A bounded read of the disposable GitLab.com fixture verified permission field
names, pipeline permission shape, the `merge_when_checks_pass` strategy and
GraphQL discussion IDs (`DiffDiscussion` / `IndividualNoteDiscussion` followed
by a 40-character hash). The adapter strips only recognized type prefixes to
obtain the REST discussion ID. Public schema introspection verified
`MergeRequestSetDraftInput`; draft toggles use that mutation rather than
rewriting an MR title. No live write, merge or fixture deletion was performed.

Synthetic tests cover all 14 supported actions with successful readback and
failed readback, permission denial/missing data, stale heads, unsupported
hosts, identity mismatches, GraphQL errors, quick-action refusal, bounded
discussion permissions and provider-qualified UI/bulk dispatch. CI retry can
finish before readback, and a no-op rebase can leave the SHA unchanged; these
return unverified rather than manufacturing proof. Required approval rules,
reauthentication, merge trains and self-managed hosts still lack live fixtures.

Contracts checked against GitLab's [merge request API](https://docs.gitlab.com/api/merge_requests/),
[approval API](https://docs.gitlab.com/api/merge_request_approvals/),
[discussion API](https://docs.gitlab.com/api/discussions/),
[notes API](https://docs.gitlab.com/api/notes/) and
[GraphQL schema](https://docs.gitlab.com/api/graphql/reference/).
