//! GitLab.com authentication discovery. `glab` owns the credential; this
//! module never reads a token or forwards CLI output to logs or the phone.

use serde::Serialize;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

pub const HOST: &str = "gitlab.com";
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthIssue {
    MissingCli,
    Unverified,
    TimedOut,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthState {
    pub host: &'static str,
    pub ok: bool,
    pub issue: Option<AuthIssue>,
    pub message: &'static str,
}

impl AuthState {
    fn ready() -> Self {
        Self {
            host: HOST,
            ok: true,
            issue: None,
            message: "",
        }
    }

    fn failed(issue: AuthIssue) -> Self {
        let message = match issue {
            AuthIssue::MissingCli => "GitLab CLI (glab) was not found on the desktop running Headstate. Install glab there and run `glab auth login --hostname gitlab.com`.",
            AuthIssue::Unverified => "GitLab.com authentication could not be verified. Run `glab auth status --hostname gitlab.com` on the desktop running Headstate; sign in again there if the credential expired.",
            AuthIssue::TimedOut => "GitLab.com authentication check timed out. Check the desktop's connection and try again.",
        };
        Self {
            host: HOST,
            ok: false,
            issue: Some(issue),
            message,
        }
    }
}

/// Resolve the same binary for auth and tool diagnostics. An explicit
/// override helps GUI launches whose PATH omits package-manager installs.
pub fn find_glab() -> Option<PathBuf> {
    let fallbacks: &[&str] = if cfg!(target_os = "macos") {
        &[
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/opt/local/bin",
            "/usr/bin",
        ]
    } else if cfg!(windows) {
        &[
            r"C:\Program Files\GitLab CLI",
            r"C:\ProgramData\chocolatey\bin",
        ]
    } else {
        &[
            "/usr/bin",
            "/usr/local/bin",
            "/snap/bin",
            "/home/linuxbrew/.linuxbrew/bin",
        ]
    };
    crate::auth::find_exe_with(
        &format!("glab{}", std::env::consts::EXE_SUFFIX),
        fallbacks,
        std::env::var("PATH").ok().as_deref(),
        std::env::var("HEADSTATE_GLAB").ok().as_deref(),
    )
}

/// Check exactly GitLab.com. A self-managed host requires an explicit
/// configured-host and fixture contract in a later slice. No ambient git
/// remote or GITLAB_HOST may silently change the host being checked.
pub async fn check() -> AuthState {
    let Some(glab) = find_glab() else {
        return AuthState::failed(AuthIssue::MissingCli);
    };
    check_with_program(&glab, PROBE_TIMEOUT).await
}

async fn check_with_program(glab: &std::path::Path, timeout: Duration) -> AuthState {
    let mut command = tokio::process::Command::new(glab);
    command
        .args(["auth", "status", "--hostname", HOST])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    match tokio::time::timeout(timeout, command.status()).await {
        Ok(Ok(status)) if status.success() => AuthState::ready(),
        Ok(_) => AuthState::failed(AuthIssue::Unverified),
        Err(_) => AuthState::failed(AuthIssue::TimedOut),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_failure_is_static_and_contains_no_cli_output() {
        for issue in [
            AuthIssue::MissingCli,
            AuthIssue::Unverified,
            AuthIssue::TimedOut,
        ] {
            let state = AuthState::failed(issue);
            assert!(!state.ok);
            assert_eq!(state.host, "gitlab.com");
            assert!(!state.message.contains("token="));
            assert!(state.message.contains("desktop"));
        }
    }

    #[cfg(unix)]
    async fn fake_glab(script: &str, timeout: Duration) -> AuthState {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let program = dir.path().join("glab");
        std::fs::write(&program, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        check_with_program(&program, timeout).await
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn host_is_explicit_and_cli_output_never_crosses_the_wire() {
        let state = fake_glab(
            "test \"$1 $2 $3 $4\" = \"auth status --hostname gitlab.com\" || exit 2\nprintf SENSITIVE\nprintf SENSITIVE >&2",
            Duration::from_secs(1),
        ).await;
        assert!(state.ok);
        assert!(!serde_json::to_string(&state).unwrap().contains("SENSITIVE"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn refused_credential_cannot_block_a_different_provider() {
        let state = fake_glab("exit 1", Duration::from_secs(1)).await;
        assert!(!state.ok);
        assert_eq!(state.issue, Some(AuthIssue::Unverified));
        assert!(!serde_json::to_string(&state).unwrap().contains("GitHub"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn hung_probe_is_bounded() {
        let state = fake_glab("sleep 2", Duration::from_millis(20)).await;
        assert_eq!(state.issue, Some(AuthIssue::TimedOut));
    }
}
