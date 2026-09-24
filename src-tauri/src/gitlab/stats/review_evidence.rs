//! Current formal review outcomes. GitLab's approvals endpoint reports current
//! approvers and their approval times; its reviewers endpoint reports current
//! reviewer states. Neither endpoint is an event history or dates the first
//! submitted review, so this receipt never claims a first-review latency.
use super::*;

const MAX_MRS: usize = 10;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewEvidence {
    pub mrs_total: usize,
    pub approvals_checked: usize,
    pub changes_checked: usize,
    pub approvals_complete: bool,
    pub changes_complete: bool,
    pub current_approvals: Option<usize>,
    pub current_change_requests: Option<usize>,
    pub mean_first_current_approval_hours: Option<f64>,
    pub timed_approved_mrs: usize,
    pub reviewers: Vec<ReviewOutcome>,
    pub failures: Vec<String>,
    pub rate_remaining: Option<u64>,
    pub rate_reset: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewOutcome {
    pub username: String,
    pub approvals: usize,
    pub change_requests: usize,
}

struct ApprovalRows {
    entries: Vec<(String, DateTime<Utc>)>,
    first: DateTime<Utc>,
}

fn approvals(body: &Value, mr: &Record) -> Option<ApprovalRows> {
    if body.get("iid")?.as_u64()? != mr.iid {
        return None;
    }
    let mut seen = HashSet::new();
    let mut entries = Vec::new();
    for row in body.get("approved_by")?.as_array()? {
        let username = row.pointer("/user/username")?.as_str()?;
        let at = timestamp(row, "approved_at")?;
        if username.is_empty() || at < mr.created_at || !seen.insert(username) {
            return None;
        }
        entries.push((username.to_owned(), at));
    }
    let first = entries.iter().map(|(_, at)| *at).min()?;
    Some(ApprovalRows { entries, first })
}

fn reviewer_states(body: &Value) -> Option<Vec<String>> {
    let mut seen = HashSet::new();
    let mut requested = Vec::new();
    for row in body.as_array()? {
        let username = row.pointer("/user/username")?.as_str()?;
        let state = row.get("state")?.as_str()?;
        if username.is_empty() || !seen.insert(username) {
            return None;
        }
        match state {
            "requested_changes" => requested.push(username.to_owned()),
            "unreviewed" | "review_started" | "reviewed" | "approved" | "unapproved" => {}
            _ => return None,
        }
    }
    Some(requested)
}

pub(super) async fn load(program: &Path, report: &Report, budget: Duration) -> ReviewEvidence {
    let started = tokio::time::Instant::now();
    let mut result = ReviewEvidence {
        mrs_total: report.history.len(),
        approvals_checked: 0,
        changes_checked: 0,
        approvals_complete: false,
        changes_complete: false,
        current_approvals: None,
        current_change_requests: None,
        mean_first_current_approval_hours: None,
        timed_approved_mrs: 0,
        reviewers: vec![],
        failures: vec![],
        rate_remaining: None,
        rate_reset: None,
    };
    let mut people = BTreeMap::<String, (usize, usize)>::new();
    let mut first_approval_hours = Vec::new();
    let mut stopped = false;
    for mr in report.history.iter().take(MAX_MRS) {
        let base = format!("projects/{}/merge_requests/{}", encode(&mr.project), mr.iid);
        for (suffix, is_approval) in [("approvals", true), ("reviewers", false)] {
            let remaining = budget.saturating_sub(started.elapsed());
            if remaining.is_zero() {
                result
                    .failures
                    .push("Load budget exhausted before requesting more review outcomes".into());
                stopped = true;
                break;
            }
            match request(
                program,
                &report.source.host,
                &format!("{base}/{suffix}"),
                remaining,
            )
            .await
            {
                Ok(response) => {
                    result.rate_remaining = response.remaining;
                    result.rate_reset = response.reset;
                    if is_approval {
                        // Empty approved_by is a measured zero, not missing data.
                        if response
                            .body
                            .get("approved_by")
                            .and_then(Value::as_array)
                            .is_some_and(Vec::is_empty)
                            && response.body.get("iid").and_then(Value::as_u64) == Some(mr.iid)
                        {
                            result.approvals_checked += 1;
                            result.current_approvals.get_or_insert(0);
                        } else if let Some(ApprovalRows { entries, first }) =
                            approvals(&response.body, mr)
                        {
                            result.approvals_checked += 1;
                            *result.current_approvals.get_or_insert(0) += entries.len();
                            first_approval_hours
                                .push((first - mr.created_at).num_seconds() as f64 / 3600.0);
                            for (username, _) in entries {
                                people.entry(username).or_default().0 += 1;
                            }
                        } else {
                            result
                                .failures
                                .push("GitLab returned unreadable approval evidence".into());
                        }
                    } else if let Some(requested) = reviewer_states(&response.body) {
                        result.changes_checked += 1;
                        *result.current_change_requests.get_or_insert(0) += requested.len();
                        for username in requested {
                            people.entry(username).or_default().1 += 1;
                        }
                    } else {
                        result
                            .failures
                            .push("GitLab returned unreadable reviewer states".into());
                    }
                    if response.remaining == Some(0) {
                        result
                            .failures
                            .push("GitLab rate limit reached while reading review outcomes".into());
                        stopped = true;
                        break;
                    }
                }
                Err(failure) => {
                    result.failures.push(error(&failure.stop));
                    if failure.stop == Stop::RateLimited {
                        result.rate_remaining = failure.remaining;
                        result.rate_reset = failure.reset;
                        stopped = true;
                        break;
                    }
                }
            }
        }
        if stopped || started.elapsed() >= budget {
            break;
        }
    }
    result.approvals_complete =
        report.coverage.complete && result.approvals_checked == result.mrs_total;
    result.changes_complete =
        report.coverage.complete && result.changes_checked == result.mrs_total;
    if result.mrs_total == 0 && report.coverage.complete {
        result.current_approvals = Some(0);
        result.current_change_requests = Some(0);
    }
    result.timed_approved_mrs = first_approval_hours.len();
    result.mean_first_current_approval_hours = (result.approvals_complete
        && !first_approval_hours.is_empty())
    .then(|| first_approval_hours.iter().sum::<f64>() / first_approval_hours.len() as f64);
    result.reviewers = people
        .into_iter()
        .map(|(username, (approvals, change_requests))| ReviewOutcome {
            username,
            approvals,
            change_requests,
        })
        .collect();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn current_approvals_require_identity_and_timestamps() {
        let mr = record(
            &super::super::tests::sample(1),
            &source("gitlab.com").unwrap(),
        )
        .unwrap();
        let value = json!({"iid":1,"approved_by":[{"user":{"username":"alice"},"approved_at":"2026-09-01T12:00:00Z"}]});
        let ApprovalRows { entries, first } = approvals(&value, &mr).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!((first - mr.created_at).num_hours(), 2);
        let mut bad = value.clone();
        bad["approved_by"][0]
            .as_object_mut()
            .unwrap()
            .remove("approved_at");
        assert!(approvals(&bad, &mr).is_none());
        bad = value.clone();
        bad["iid"] = json!(2);
        assert!(approvals(&bad, &mr).is_none());
    }

    #[test]
    fn only_explicit_requested_changes_count() {
        assert_eq!(
            reviewer_states(&json!([
                {"user":{"username":"alice"},"state":"requested_changes"},
                {"user":{"username":"bob"},"state":"reviewed"},
                {"user":{"username":"carol"},"state":"unreviewed"}
            ])),
            Some(vec!["alice".into()])
        );
        assert_eq!(
            reviewer_states(&json!([{"user":{"username":"alice"},"state":"future_state"}])),
            None
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rate_limit_preserves_approval_receipt_and_skips_later_mrs() {
        use std::os::unix::fs::PermissionsExt;
        let report = super::super::tests::report(vec![
            super::super::tests::sample(1),
            super::super::tests::sample(2),
        ]);
        let dir = tempfile::tempdir().unwrap();
        let program = dir.path().join("glab");
        std::fs::write(
            &program,
            r##"#!/bin/sh
printf '%s\n' "$5" >> "$0.calls"
case "$5" in
  */1/approvals) printf 'HTTP/2 200\n\n{"iid":1,"approved_by":[{"user":{"username":"alice"},"approved_at":"2026-09-01T12:00:00Z"}]}' ;;
  */1/reviewers) printf 'HTTP/2 429\nratelimit-remaining: 0\n\nlimited'; exit 1 ;;
  *) exit 1 ;;
esac
"##,
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        let result = load(&program, &report, Duration::from_secs(2)).await;
        assert_eq!(result.approvals_checked, 1);
        assert_eq!(result.current_approvals, Some(1));
        assert_eq!(result.current_change_requests, None);
        assert!(!result.approvals_complete);
        assert_eq!(result.rate_remaining, Some(0));
        let calls = std::fs::read_to_string(program.with_extension("calls")).unwrap();
        assert_eq!(calls.lines().count(), 2);
    }
}
