//! Explicit, incremental backfill. One closed UTC day per user request; no
//! background API spend. Completed days are retained and skipped on resume.
use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Backfill {
    pub source: Source,
    pub viewer: String,
    pub scope: Scope,
    pub requested_days: u32,
    pub complete_days: usize,
    pub slices: Vec<Report>,
    pub error: Option<String>,
}

pub async fn backfill(
    host: &str,
    scope: Scope,
    days: u32,
    db: std::path::PathBuf,
) -> Result<Backfill, String> {
    let source = source(host)?;
    endpoint(&scope)?;
    if !(1..=90).contains(&days) {
        return Err("GitLab history window must be 1 to 90 closed days".into());
    }
    let program =
        super::super::auth::find_glab().ok_or("GitLab CLI (glab) was not found on the desktop")?;
    let viewer = viewer(&program, host).await?;
    let today = Utc::now().date_naive();
    let partition =
        serde_json::to_string(&("gitlab", host, &viewer, &scope)).map_err(|e| e.to_string())?;
    let mut result = Backfill {
        source: source.clone(),
        viewer: viewer.clone(),
        scope: scope.clone(),
        requested_days: days,
        complete_days: 0,
        slices: vec![],
        error: None,
    };
    let mut fetched = false;
    for offset in 1..=days {
        let day = today - chrono::Duration::days(i64::from(offset));
        let path = db.clone();
        let key = partition.clone();
        let date = day.to_string();
        let cached = tokio::task::spawn_blocking(move || {
            crate::store::gitlab_stats::history_get(&path, &key, &date)
        })
        .await
        .map_err(|_| "Could not read GitLab history".to_string())??;
        let complete = |r: &Report| {
            r.coverage.complete
                && r.merged_window
                    .as_ref()
                    .is_some_and(|m| m.coverage.complete)
        };
        let slice = if cached.as_ref().is_some_and(complete) || fetched {
            cached
        } else {
            fetched = true;
            let start = day.and_hms_opt(0, 0, 0).unwrap().and_utc();
            let end = (day
                .succ_opt()
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap()
                .and_utc())
                - chrono::Duration::nanoseconds(1);
            match load_window(
                &program,
                source.clone(),
                viewer.clone(),
                scope.clone(),
                start,
                end,
            )
            .await
            {
                Ok(report) => {
                    let path = db.clone();
                    let key = partition.clone();
                    let saved = report.clone();
                    let saved_result = tokio::task::spawn_blocking(move || {
                        crate::store::gitlab_stats::history_put(&path, &key, &saved)
                    })
                    .await;
                    if !matches!(saved_result, Ok(Ok(()))) {
                        result.error = Some("Retrieved history could not be saved; retry may request this day again".into());
                    }
                    Some(report)
                }
                Err(error) => {
                    result.error = Some(error);
                    cached
                }
            }
        };
        if let Some(slice) = slice {
            if complete(&slice) {
                result.complete_days += 1;
            }
            result.slices.push(slice);
        }
    }
    Ok(result)
}
