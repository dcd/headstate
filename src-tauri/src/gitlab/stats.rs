//! GitLab-only created-cohort statistics. Bounds and coverage are part of the
//! answer, including after persistence. A reviewer assignment is not a review.
use crate::identity::{Provider, Source};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashSet},
    path::Path,
    process::Stdio,
    time::Duration,
};

const PAGE_SIZE: usize = 100;
const MAX_PAGES: usize = 10;
const BUDGET: Duration = Duration::from_secs(45);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "path", rename_all = "snake_case")]
pub enum Scope {
    Mine,
    Project(String),
    Group(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Stop {
    Complete,
    PageLimit,
    Timeout,
    RateLimited,
    Unauthorized,
    Forbidden,
    RequestFailed,
    InvalidData,
    UnknownPagination,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Coverage {
    pub complete: bool,
    pub stop: Stop,
    pub pages: usize,
    pub received: usize,
    pub total: Option<u64>,
    pub rate_remaining: Option<u64>,
    pub rate_reset: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub path: String,
    pub namespace: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tree {
    pub source: Source,
    pub viewer: String,
    pub projects: Vec<Project>,
    pub coverage: Coverage,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Record {
    pub source: Source,
    pub project: String,
    pub iid: u64,
    pub title: String,
    pub url: String,
    pub author: String,
    pub state: String,
    pub created_at: DateTime<Utc>,
    pub merged_at: Option<DateTime<Utc>>,
    /// Missing reviewer arrays stay unknown, including on the leaderboard.
    pub reviewers: Option<Vec<String>>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Counts {
    pub created: usize,
    pub merged: usize,
    pub closed: usize,
    pub opened: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Day {
    pub day: String,
    pub created: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Author {
    pub username: String,
    pub created: usize,
    pub merged: usize,
    pub mean_merge_hours: Option<f64>,
    pub timed_merges: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reviewer {
    pub username: String,
    pub assigned: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Report {
    pub source: Source,
    pub viewer: String,
    pub scope: Scope,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub fetched_at: DateTime<Utc>,
    pub coverage: Coverage,
    pub counts: Counts,
    pub series: Vec<Day>,
    pub authors: Vec<Author>,
    pub reviewers: Vec<Reviewer>,
    pub reviewer_rows_measured: usize,
    pub review_activity: Option<usize>,
    pub history: Vec<Record>,
}

fn source(host: &str) -> Result<Source, String> {
    if host != super::auth::HOST {
        return Err(
            "GitLab statistics are enabled only for gitlab.com; self-managed validation is pending"
                .into(),
        );
    }
    Ok(Source {
        provider: Provider::Gitlab,
        host: host.into(),
    })
}
fn path_ok(path: &str) -> bool {
    !path.is_empty()
        && path.split('/').all(|s| {
            !s.is_empty()
                && s != "."
                && s != ".."
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        })
}
fn encode(path: &str) -> String {
    path.replace('/', "%2F")
}
fn endpoint(scope: &Scope) -> Result<String, String> {
    match scope {
        Scope::Mine => Ok("merge_requests?scope=created_by_me".into()),
        Scope::Project(path) if path_ok(path) => Ok(format!(
            "projects/{}/merge_requests?scope=all",
            encode(path)
        )),
        Scope::Group(path) if path_ok(path) => {
            Ok(format!("groups/{}/merge_requests?scope=all", encode(path)))
        }
        _ => Err("invalid GitLab project or group path".into()),
    }
}
struct Response {
    body: Value,
    next: Option<usize>,
    terminal: bool,
    total: Option<u64>,
    remaining: Option<u64>,
    reset: Option<u64>,
}
fn parse(raw: &[u8], success: bool) -> Result<Response, Stop> {
    let text = std::str::from_utf8(raw)
        .map_err(|_| Stop::InvalidData)?
        .replace("\r\n", "\n");
    let (headers, body) = text.split_once("\n\n").ok_or(Stop::RequestFailed)?;
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or(Stop::InvalidData)?;
    match status {
        401 => return Err(Stop::Unauthorized),
        403 => return Err(Stop::Forbidden),
        429 => return Err(Stop::RateLimited),
        200..=299 if success => {}
        _ => return Err(Stop::RequestFailed),
    }
    let mut out = Response {
        body: serde_json::from_str(body).map_err(|_| Stop::InvalidData)?,
        next: None,
        terminal: false,
        total: None,
        remaining: None,
        reset: None,
    };
    for line in headers.lines().skip(1) {
        if let Some((key, value)) = line.split_once(':') {
            let value = value.trim();
            match key.to_ascii_lowercase().as_str() {
                "x-next-page" => {
                    out.terminal = true;
                    if !value.is_empty() {
                        out.next = Some(value.parse().map_err(|_| Stop::InvalidData)?);
                    }
                }
                "x-total" => out.total = value.parse().ok(),
                "ratelimit-remaining" => out.remaining = value.parse().ok(),
                "ratelimit-reset" => out.reset = value.parse().ok(),
                _ => {}
            }
        }
    }
    Ok(out)
}
async fn request(
    program: &Path,
    host: &str,
    endpoint: &str,
    budget: Duration,
) -> Result<Response, Stop> {
    let output = tokio::time::timeout(
        budget.min(REQUEST_TIMEOUT),
        tokio::process::Command::new(program)
            .args(["api", "--hostname", host, "-i", endpoint])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| Stop::Timeout)?
    .map_err(|_| Stop::RequestFailed)?;
    parse(&output.stdout, output.status.success())
}
fn error(stop: &Stop) -> String {
    match stop {
        Stop::Unauthorized => "GitLab authentication expired; sign in again on the desktop",
        Stop::Forbidden => "GitLab denied access to this statistics scope",
        Stop::RateLimited => "GitLab rate limit reached; try again later",
        Stop::Timeout => "GitLab statistics request timed out",
        Stop::InvalidData => "GitLab returned unreadable statistics",
        _ => "GitLab statistics request failed",
    }
    .into()
}
async fn viewer(program: &Path, host: &str) -> Result<String, String> {
    let out = request(program, host, "user", REQUEST_TIMEOUT)
        .await
        .map_err(|s| error(&s))?;
    // Numeric id is stable across username changes and isolates accounts.
    out.body
        .get("id")
        .and_then(Value::as_u64)
        .map(|id| id.to_string())
        .ok_or_else(|| error(&Stop::InvalidData))
}
async fn pages(
    program: &Path,
    host: &str,
    base: &str,
    budget: Duration,
) -> Result<(Vec<Value>, Coverage), String> {
    let started = tokio::time::Instant::now();
    let mut rows = Vec::new();
    let mut page_number = 1;
    let mut total_conflict = false;
    let mut coverage = Coverage {
        complete: false,
        stop: Stop::PageLimit,
        pages: 0,
        received: 0,
        total: None,
        rate_remaining: None,
        rate_reset: None,
    };
    for _ in 0..MAX_PAGES {
        let remaining = budget.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            coverage.stop = Stop::Timeout;
            break;
        }
        let out = match request(
            program,
            host,
            &format!("{base}&per_page={PAGE_SIZE}&page={page_number}"),
            remaining,
        )
        .await
        {
            Ok(out) => out,
            Err(stop) if coverage.pages == 0 => return Err(error(&stop)),
            Err(stop) => {
                coverage.stop = stop;
                break;
            }
        };
        let Some(page_rows) = out.body.as_array() else {
            if coverage.pages == 0 {
                return Err(error(&Stop::InvalidData));
            }
            coverage.stop = Stop::InvalidData;
            break;
        };
        coverage.pages += 1;
        coverage.rate_remaining = out.remaining;
        coverage.rate_reset = out.reset;
        if let Some(total) = out.total {
            if coverage.total.is_some_and(|prior| prior != total) {
                total_conflict = true;
            }
            coverage.total = if total_conflict { None } else { Some(total) };
        }
        rows.extend(page_rows.iter().cloned());
        if out.terminal && out.next.is_none() {
            coverage.complete = true;
            coverage.stop = Stop::Complete;
            break;
        }
        if out.remaining == Some(0) {
            coverage.stop = Stop::RateLimited;
            break;
        }
        match out.next {
            Some(next) if next == page_number + 1 => page_number = next,
            Some(_) => {
                coverage.stop = Stop::InvalidData;
                break;
            }
            None if page_rows.len() < PAGE_SIZE => {
                coverage.stop = Stop::UnknownPagination;
                break;
            }
            None => page_number += 1,
        }
    }
    coverage.received = rows.len();
    if total_conflict
        || coverage
            .total
            .is_some_and(|n| n != rows.len() as u64 && coverage.complete || n < rows.len() as u64)
    {
        coverage.complete = false;
        coverage.stop = Stop::InvalidData;
        coverage.total = None;
    }
    Ok((rows, coverage))
}

pub async fn tree(host: &str) -> Result<Tree, String> {
    let source = source(host)?;
    let program =
        super::auth::find_glab().ok_or("GitLab CLI (glab) was not found on the desktop")?;
    let viewer = viewer(&program, host).await?;
    let (rows, mut coverage) = pages(
        &program,
        host,
        "projects?membership=true&simple=true&order_by=id&sort=asc",
        BUDGET,
    )
    .await?;
    let mut projects = BTreeMap::new();
    for row in rows {
        if let Some(path) = row
            .get("path_with_namespace")
            .and_then(Value::as_str)
            .filter(|p| path_ok(p))
        {
            let namespace =
                if row.pointer("/namespace/kind").and_then(Value::as_str) == Some("group") {
                    path.rsplit_once('/')
                        .map(|(ns, _)| ns)
                        .unwrap_or("")
                        .to_owned()
                } else {
                    String::new()
                };
            if projects
                .insert(
                    path.to_owned(),
                    Project {
                        path: path.into(),
                        namespace,
                    },
                )
                .is_none()
            {
                continue;
            }
        }
        coverage.complete = false;
        coverage.stop = Stop::InvalidData;
    }
    coverage.received = projects.len();
    Ok(Tree {
        source,
        viewer,
        projects: projects.into_values().collect(),
        coverage,
    })
}
fn timestamp(row: &Value, field: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(row.get(field)?.as_str()?)
        .ok()
        .map(|v| v.with_timezone(&Utc))
}
fn record(row: &Value, source: &Source) -> Option<Record> {
    let iid = row.get("iid")?.as_u64()?;
    let url = row.get("web_url")?.as_str()?;
    let prefix = format!("https://{}/", source.host);
    let suffix = format!("/-/merge_requests/{iid}");
    let project = url.strip_prefix(&prefix)?.strip_suffix(&suffix)?;
    if !path_ok(project) {
        return None;
    }
    let state = row.get("state")?.as_str()?;
    if !["opened", "closed", "merged"].contains(&state) {
        return None;
    }
    let created_at = timestamp(row, "created_at")?;
    let merged_at = timestamp(row, "merged_at").filter(|at| *at >= created_at);
    let reviewers = row
        .get("reviewers")
        .and_then(Value::as_array)
        .and_then(|rs| {
            rs.iter()
                .map(|r| r.get("username")?.as_str().map(str::to_owned))
                .collect()
        });
    Some(Record {
        source: source.clone(),
        project: project.into(),
        iid,
        url: url.into(),
        title: row.get("title")?.as_str()?.into(),
        author: row.get("author")?.get("username")?.as_str()?.into(),
        state: state.into(),
        created_at,
        merged_at,
        reviewers,
    })
}
fn summarize(
    source: Source,
    viewer: String,
    scope: Scope,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    raw: Vec<Value>,
    mut coverage: Coverage,
) -> Report {
    let mut seen = HashSet::new();
    let mut history = Vec::new();
    for row in raw {
        if let Some(record) = record(&row, &source) {
            let in_scope = match &scope {
                Scope::Mine => true,
                Scope::Project(p) => &record.project == p,
                Scope::Group(g) => record.project.starts_with(&format!("{g}/")),
            };
            if in_scope
                && record.created_at >= start
                && record.created_at <= end
                && seen.insert((record.project.clone(), record.iid))
            {
                history.push(record);
                continue;
            }
        }
        coverage.complete = false;
        coverage.stop = Stop::InvalidData;
    }
    coverage.received = history.len();
    let mut counts = Counts {
        created: history.len(),
        merged: 0,
        closed: 0,
        opened: 0,
    };
    let mut series = BTreeMap::<String, usize>::new();
    // Empty days only represent measured zeros when coverage is complete.
    let mut day = start.date_naive();
    while day <= end.date_naive() {
        series.insert(day.to_string(), 0);
        day = day.succ_opt().expect("bounded dates");
    }
    let mut authors = BTreeMap::<String, (usize, usize, Vec<f64>)>::new();
    let mut reviewers = BTreeMap::<String, usize>::new();
    let mut reviewer_rows_measured = 0;
    for row in &history {
        *series
            .entry(row.created_at.date_naive().to_string())
            .or_default() += 1;
        let author = authors.entry(row.author.clone()).or_default();
        author.0 += 1;
        match row.state.as_str() {
            "merged" => {
                counts.merged += 1;
                author.1 += 1;
                if let Some(at) = row.merged_at {
                    author
                        .2
                        .push((at - row.created_at).num_seconds() as f64 / 3600.0);
                }
            }
            "closed" => counts.closed += 1,
            "opened" => counts.opened += 1,
            _ => {}
        }
        if let Some(assigned) = &row.reviewers {
            reviewer_rows_measured += 1;
            for username in assigned.iter().collect::<HashSet<_>>() {
                *reviewers.entry(username.clone()).or_default() += 1;
            }
        }
    }
    let complete = coverage.complete;
    Report {
        source,
        viewer,
        scope,
        start,
        end,
        fetched_at: Utc::now(),
        coverage,
        counts,
        series: series
            .into_iter()
            .map(|(day, created)| Day { day, created })
            .collect(),
        authors: authors
            .into_iter()
            .map(|(username, (created, merged, times))| Author {
                username,
                created,
                merged,
                timed_merges: times.len(),
                mean_merge_hours: (complete && times.len() == merged && !times.is_empty())
                    .then(|| times.iter().sum::<f64>() / times.len() as f64),
            })
            .collect(),
        reviewers: reviewers
            .into_iter()
            .map(|(username, assigned)| Reviewer { username, assigned })
            .collect(),
        reviewer_rows_measured,
        review_activity: None,
        history,
    }
}

pub async fn load(
    host: &str,
    scope: Scope,
    days: u32,
    db: std::path::PathBuf,
    refresh: bool,
) -> Result<Report, String> {
    let source = source(host)?;
    let base = endpoint(&scope)?;
    if !(1..=90).contains(&days) {
        return Err("GitLab statistics window must be 1 to 90 days".into());
    }
    let program =
        super::auth::find_glab().ok_or("GitLab CLI (glab) was not found on the desktop")?;
    let viewer = viewer(&program, host).await?;
    // Whole UTC dates give a stable cache window; today's cohort is still live.
    let end = Utc::now();
    let start = (end.date_naive() - chrono::Duration::days(i64::from(days) - 1))
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc();
    let key = serde_json::to_string(&(
        "gitlab",
        host,
        &viewer,
        &scope,
        start.date_naive(),
        end.date_naive(),
    ))
    .map_err(|e| e.to_string())?;
    if !refresh {
        let path = db.clone();
        let cache_key = key.clone();
        let cached =
            tokio::task::spawn_blocking(move || crate::store::gitlab_stats::get(&path, &cache_key))
                .await
                .ok()
                .and_then(Result::ok)
                .flatten();
        if let Some(report) = cached {
            return Ok(report);
        }
    }
    let endpoint = format!(
        "{base}&state=all&order_by=created_at&sort=desc&created_after={}&created_before={}",
        start.to_rfc3339().replace('+', "%2B"),
        end.to_rfc3339().replace('+', "%2B")
    );
    let (raw, coverage) = pages(&program, host, &endpoint, BUDGET).await?;
    let report = summarize(source, viewer, scope, start, end, raw, coverage);
    let saved = report.clone();
    // Cache trouble never discards a measured result. Errors are not logged with data.
    let _ = tokio::task::spawn_blocking(move || crate::store::gitlab_stats::put(&db, &key, &saved))
        .await;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn sample(iid: u64) -> Value {
        json!({"iid": iid, "web_url": format!("https://gitlab.com/g/sub/p/-/merge_requests/{iid}"), "title":"change", "author":{"username":"author"}, "state":"merged", "created_at":"2026-09-01T10:00:00Z", "merged_at":"2026-09-02T10:00:00Z", "reviewers":[{"username":"reviewer"}]})
    }
    fn coverage() -> Coverage {
        Coverage {
            complete: true,
            stop: Stop::Complete,
            pages: 1,
            received: 1,
            total: Some(1),
            rate_remaining: None,
            rate_reset: None,
        }
    }
    fn report(rows: Vec<Value>) -> Report {
        summarize(
            source("gitlab.com").unwrap(),
            "1".into(),
            Scope::Mine,
            "2026-09-01T00:00:00Z".parse().unwrap(),
            "2026-09-03T00:00:00Z".parse().unwrap(),
            rows,
            coverage(),
        )
    }
    #[test]
    fn missing_timing_and_reviewers_do_not_become_zero() {
        let mut row = sample(1);
        row.as_object_mut().unwrap().remove("merged_at");
        row.as_object_mut().unwrap().remove("reviewers");
        let out = report(vec![row]);
        assert_eq!(out.counts.merged, 1);
        assert_eq!(out.authors[0].mean_merge_hours, None);
        assert_eq!(out.authors[0].timed_merges, 0);
        assert_eq!(out.reviewer_rows_measured, 0);
        assert_eq!(out.review_activity, None);
    }
    #[test]
    fn duplicate_invalid_and_wrong_host_rows_qualify_all_measures() {
        let mut wrong = sample(2);
        wrong["web_url"] = json!("https://other.example/g/sub/p/-/merge_requests/2");
        let out = report(vec![sample(1), sample(1), wrong, json!({})]);
        assert_eq!(out.counts.created, 1);
        assert!(!out.coverage.complete);
        assert_eq!(out.coverage.stop, Stop::InvalidData);
        assert_eq!(out.history[0].project, "g/sub/p");
        assert_eq!(out.reviewers[0].assigned, 1);
        assert_eq!(out.authors[0].mean_merge_hours, None);
    }
    #[test]
    fn scope_paths_cannot_inject_query_or_escape_namespace() {
        assert!(endpoint(&Scope::Project("a/b?scope=all".into())).is_err());
        assert!(endpoint(&Scope::Group("a/../b".into())).is_err());
        assert_eq!(
            endpoint(&Scope::Project("g/sub/p".into())).unwrap(),
            "projects/g%2Fsub%2Fp/merge_requests?scope=all"
        );
        assert!(source("local.example").is_err());
        let out = summarize(
            source("gitlab.com").unwrap(),
            "1".into(),
            Scope::Group("g/s".into()),
            "2026-09-01T00:00:00Z".parse().unwrap(),
            "2026-09-03T00:00:00Z".parse().unwrap(),
            vec![sample(1)],
            coverage(),
        );
        assert_eq!(out.history.len(), 0);
        assert!(!out.coverage.complete);
    }
    #[test]
    fn status_and_rate_headers_survive_transport() {
        assert!(matches!(
            parse(b"HTTP/2 429\n\n{}", false),
            Err(Stop::RateLimited)
        ));
        let out = parse(b"HTTP/2 200\nX-Next-Page: 2\nRateLimit-Remaining: 0\nRateLimit-Reset: 42\nX-Total: 3\n\n[]", true).unwrap();
        assert_eq!(out.next, Some(2));
        assert_eq!(out.remaining, Some(0));
        assert_eq!(out.reset, Some(42));
        assert!(!parse(b"HTTP/2 200\n\n[]", true).unwrap().terminal);
    }
    #[cfg(unix)]
    async fn scripted(script: &str, budget: Duration) -> Result<(Vec<Value>, Coverage), String> {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let program = dir.path().join("glab");
        std::fs::write(&program, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        pages(
            &program,
            "gitlab.com",
            "merge_requests?scope=created_by_me",
            budget,
        )
        .await
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn late_timeout_retains_rows_and_first_failure_is_not_empty_success() {
        let (rows, coverage) = scripted("case \"$5\" in *page=1) printf 'HTTP/2 200\\nx-next-page: 2\\nx-total: 2\\n\\n[{}]';; *) sleep 2;; esac", Duration::from_millis(300)).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert!(!coverage.complete);
        assert_eq!(coverage.stop, Stop::Timeout);
        assert!(scripted("exit 1", Duration::from_secs(1)).await.is_err());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn rate_limit_and_missing_pagination_preserve_partial_evidence() {
        let (_, coverage) = scripted(
            "printf 'HTTP/2 200\\nx-next-page: 2\\nratelimit-remaining: 0\\n\\n[{}]'",
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        assert_eq!(coverage.stop, Stop::RateLimited);
        assert_eq!(coverage.received, 1);
        let (_, coverage) = scripted("printf 'HTTP/2 200\\n\\n[]'", Duration::from_secs(1))
            .await
            .unwrap();
        assert_eq!(coverage.stop, Stop::UnknownPagination);
        assert!(!coverage.complete);
    }
    #[test]
    fn cache_separates_viewers_hosts_scopes_and_retains_coverage() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("cache.sqlite");
        let out = report(vec![sample(1), sample(1)]);
        let key = "[gitlab,gitlab.com,viewer1,mine]";
        crate::store::gitlab_stats::put(&db, key, &out).unwrap();
        assert!(
            crate::store::gitlab_stats::get(&db, "[github,github.com,viewer1,mine]")
                .unwrap()
                .is_none()
        );
        assert!(
            crate::store::gitlab_stats::get(&db, "[gitlab,gitlab.com,viewer2,mine]")
                .unwrap()
                .is_none()
        );
        let cached = crate::store::gitlab_stats::get(&db, key).unwrap().unwrap();
        assert!(!cached.coverage.complete);
        assert_eq!(cached.history.len(), 1);
    }
}
