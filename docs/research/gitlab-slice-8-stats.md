# GitLab slice 8: created-cohort statistics checkpoint

2026-09-23. Implementation: Astra/high. Independent Astra/xhigh review pending.
This is an incremental slice 8 checkpoint, **not the full slice exit**.

## Implemented contract

GitLab.com has its own statistics page and, in Both mode, a separate provider
button. No count, mean, query key or persistent receipt is shared with GitHub.
The slice 6 integration must pass its persisted `selection` into
`ProviderStatsPage`; this standalone checkpoint defaults to GitHub. Integration
must hide the GitHub scope sidebar while the GitLab tab is selected.

Scope discovery reads membership projects with bounded pagination. Project
namespaces known to be groups are offered as group scopes. This is discovery
among membership projects, not an assertion that all token-visible groups and
projects have been enumerated. My authored MRs remains a distinct scope.

Statistics describe MRs **created in the selected 1–90 day UTC window**,
including today. Created counts, current opened/closed/merged counts, daily
created series, author counts, mean time from creation to merge, current
reviewer assignments, and MR history all describe this same cohort. A merged
count here does not mean all MRs merged during the window. Mean merge time is
withheld unless cohort pagination and every merged timestamp are complete.
Reviewer assignments are explicitly not review activity; actual review events
and response times are unavailable. Missing arrays and timestamps never become
zero. Partial counts and day values are lower bounds, including `at least 0`.

Each discovery/load has at most ten 100-row pages, a 45-second paging budget,
and ten seconds per request. A separate ten-second `/user` read resolves the
credential's stable numeric account ID. The host is always explicit and only
`gitlab.com` is enabled. Later-page failure preserves measured rows; first-page
failure rejects without inventing an empty result. Missing pagination headers,
contradictory totals, duplicate/malformed rows, and skipped page numbers cannot
produce complete coverage. Rate limit remaining/reset headers and stop causes
survive the wire and cache.

The new SQLite table is additive. JSON keys include provider, host, stable
viewer ID, scope and UTC date window. Five-minute receipts include coverage and
history. The UI requests fresh reads on mount/refresh and does not retain its
query cache after unmount; the backend supports short-lived cache reads for
other consumers. Cache errors do not erase successful network answers. This
is snapshot history, not an accumulated backfill ledger. Existing GitHub
history and cache tables retain their original meaning.

Both desktop command registrations and phone read allowlists/dispatch include
`gitlab_stats_tree` and `gitlab_stats_load`. No token is read by this adapter,
logged, persisted, or transported to the phone; `glab` owns authentication.

## Outstanding slice 8 work

- Merged-in-window series/counts across MRs created before the selected window.
- Review-event counts, reviewer participation, first-review/response latency,
  and review outcome measures. Assignments alone cannot establish any of these.
- Historical accumulation/backfill, per-slice ledger, incremental resume, and
  retained history outside the current bounded receipt. No background API spend.
- Richer scope hierarchy beyond groups represented by discovered membership
  projects (parent groups, external token-visible scopes, people scopes).
- Live large-cohort measurements, paging mutation behavior, populated reviewer
  events, rate-limit headers under actual throttling, and timeout fixture evidence.
- Self-managed host/version/permission validation.
- Assembled selector/sidebar navigation and paired-phone smoke validation.

## Evidence

Synthetic Rust tests exercise missing measures, host/path rejection, dedup,
timeout preservation, first-page failure, rate limits, unknown pagination, and
cache partition/coverage persistence. Component tests distinguish measured zero
from partial lower bounds and suppress missing/biased means. They do not claim
live GitLab API validation. Existing slice 0 supplies GitLab.com list/header
shape provenance; its two-draft fixture does not validate merged cohort metrics.

The [GitLab merge requests API](https://docs.gitlab.com/api/merge_requests/)
documents `created_after`, `created_before`, created scopes and project/group
list endpoints. This checkpoint uses those REST filters with explicit scope.

## Review corrections to the checkpoint

The Astra/xhigh review of `6fa932b` requested two P2 fixes. HTTP 429 responses
now carry their rate headers even when the error body is non-JSON. Later-page
429s replace the receipt's previous remaining/reset values; missing headers
clear those values to unknown. Retrieved rows and corrected coverage survive
cache persistence. A synthetic two-page regression covers both header cases.

Refresh now starts a new scope discovery before mounting statistics again,
including retrying partial project discovery. Scope selection is associated
with the discovered host/account; changing accounts resets the selection to
My authored MRs and removes the previous account's project options. A stats
response with a different viewer or source is rejected before the query cache
can assign it to the discovery account's key. Component regressions exercise
same-account partial discovery retry, account-switch refresh, and a switch
between discovery and the stats response followed by recovery.

Follow-up focused evidence: 8 Rust stats tests and 9 Vitest tests (6 GitLab
statistics component tests plus 3 surface guards) passed. Full release gates
and independent re-review remain separate requirements; this correction does
not close the broader slice 8 work listed above.
