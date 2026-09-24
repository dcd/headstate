//! Persisted GitLab host contract. A host is an HTTPS DNS name, not a URL,
//! token, port, or a value inferred from the current repository remote.

use rusqlite::Connection;
use rusqlite::OptionalExtension;
use std::net::IpAddr;

pub const DEFAULT: &str = "gitlab.com";

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum HostError {
    #[error(
        "Enter a GitLab DNS hostname, such as gitlab.example.com, without a scheme, port, or path."
    )]
    Invalid,
    #[error("The saved GitLab host is invalid. Set a valid host in Settings before using GitLab.")]
    InvalidSaved,
    #[error("Could not read or save the GitLab host setting.")]
    Storage,
}

/// Canonicalize only case. Refuse formats that could change where `glab`
/// sends credentials or permit an apparently similar host to bypass a gate.
pub fn validate(input: &str) -> Result<String, HostError> {
    if input != input.trim() || input.len() > 253 || input.is_empty() {
        return Err(HostError::Invalid);
    }
    let host = input.to_ascii_lowercase();
    if host.parse::<IpAddr>().is_ok() || !host.contains('.') {
        return Err(HostError::Invalid);
    }
    if !host.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    }) {
        return Err(HostError::Invalid);
    }
    Ok(host)
}

pub fn read_host(conn: &Connection) -> Result<String, HostError> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [crate::store::settings::keys::GITLAB_HOST],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| HostError::Storage)?;
    match raw {
        Some(raw) => {
            let value: String = serde_json::from_str(&raw).map_err(|_| HostError::InvalidSaved)?;
            validate(&value).map_err(|_| HostError::InvalidSaved)
        }
        None => Ok(DEFAULT.into()),
    }
}

pub fn write_host(conn: &Connection, input: &str) -> Result<String, HostError> {
    let host = validate(input)?;
    crate::store::settings::set(conn, crate::store::settings::keys::GITLAB_HOST, &host)
        .map_err(|_| HostError::Storage)?;
    Ok(host)
}

/// Enforce an explicit configured host at each remote boundary. Callers
/// must fail closed if the setting is missing, invalid, or changed.
pub fn permits(conn: &Connection, candidate: &str) -> Result<bool, HostError> {
    Ok(validate(candidate)? == read_host(conn)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_canonical_dns_names() {
        assert_eq!(
            validate("GitLab.Example.COM"),
            Ok("gitlab.example.com".into())
        );
        assert_eq!(
            validate("gitlab-fixture.k3s.dcd.cloud"),
            Ok("gitlab-fixture.k3s.dcd.cloud".into())
        );
        for input in [
            "",
            " gitlab.com",
            "gitlab.com ",
            "localhost",
            "127.0.0.1",
            "[::1]",
            "https://gitlab.com",
            "gitlab.com:443",
            "gitlab.com/path",
            "user@gitlab.com",
            "gitlab..com",
            "-gitlab.com",
            "gitlab-.com",
            "gitlab.com.",
            "gitlab.com\n--help",
        ] {
            assert_eq!(validate(input), Err(HostError::Invalid), "{input:?}");
        }
    }

    #[test]
    fn saved_host_survives_restart_and_invalid_value_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host.db");
        {
            let conn = crate::store::open_db(&path).unwrap();
            assert_eq!(read_host(&conn), Ok(DEFAULT.into()));
            assert_eq!(
                write_host(&conn, "GITLAB.Example"),
                Ok("gitlab.example".into())
            );
            assert_eq!(permits(&conn, "gitlab.com"), Ok(false));
            assert_eq!(permits(&conn, "gitlab.example"), Ok(true));
        }
        let conn = crate::store::open_db(&path).unwrap();
        assert_eq!(read_host(&conn), Ok("gitlab.example".into()));
        assert_eq!(
            write_host(&conn, "https://wrong.example"),
            Err(HostError::Invalid)
        );
        assert_eq!(read_host(&conn), Ok("gitlab.example".into()));
        crate::store::settings::set(
            &conn,
            crate::store::settings::keys::GITLAB_HOST,
            &"wrong.example/path",
        )
        .unwrap();
        assert_eq!(read_host(&conn), Err(HostError::InvalidSaved));
        assert_eq!(permits(&conn, "gitlab.com"), Err(HostError::InvalidSaved));
    }
}
