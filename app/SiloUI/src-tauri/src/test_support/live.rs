//! Live regressions require a separate opt-in before any external side effect.
use std::path::{Path, PathBuf};

pub(crate) const CONFIRM_VARIABLE: &str = "SILO_LIVE_TEST_CONFIRM";
pub(crate) const CONFIRM_VALUE: &str = "disposable-test-fixtures";

pub(crate) fn validate_confirmation(value: Option<&str>) -> Result<(), &'static str> {
    if value == Some(CONFIRM_VALUE) {
        Ok(())
    } else {
        Err("Live tests require SILO_LIVE_TEST_CONFIRM=disposable-test-fixtures.")
    }
}

pub(crate) fn require_confirmation() {
    validate_confirmation(std::env::var(CONFIRM_VARIABLE).ok().as_deref())
        .expect("Live test authorization missing");
}

pub(crate) fn isolated_editor_home(home: &Path, real_home: &Path) -> Result<PathBuf, &'static str> {
    if !home.is_absolute() || !real_home.is_absolute() {
        return Err("Live editor tests require absolute, existing fixture and user homes.");
    }
    let home = home
        .canonicalize()
        .map_err(|_| "Cannot resolve fixture home.")?;
    let real_home = real_home
        .canonicalize()
        .map_err(|_| "Cannot resolve user home.")?;
    if home == real_home {
        return Err("Live editor tests refuse a fixture home equal to HOME.");
    }
    Ok(home)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confirmation_requires_the_exact_opt_in() {
        for value in [None, Some(""), Some("1"), Some("disposable-test-fixtures ")] {
            assert!(validate_confirmation(value).is_err());
        }
        assert!(validate_confirmation(Some(CONFIRM_VALUE)).is_ok());
    }

    #[test]
    fn editor_home_refuses_the_real_home_and_relative_paths() {
        let directory = tempfile::tempdir().unwrap();
        let real = directory.path().join("real");
        let fixture = directory.path().join("fixture");
        std::fs::create_dir(&real).unwrap();
        std::fs::create_dir(&fixture).unwrap();
        assert!(isolated_editor_home(&real, &real).is_err());
        assert!(isolated_editor_home(&real.join("."), &real).is_err());
        assert!(isolated_editor_home(Path::new("fixture"), &real).is_err());
        assert_eq!(
            isolated_editor_home(&fixture, &real).unwrap(),
            fixture.canonicalize().unwrap()
        );
    }

    #[cfg(unix)]
    #[test]
    fn editor_home_refuses_a_symlink_to_the_real_home() {
        let directory = tempfile::tempdir().unwrap();
        let real = directory.path().join("real");
        let alias = directory.path().join("alias");
        std::fs::create_dir(&real).unwrap();
        std::os::unix::fs::symlink(&real, &alias).unwrap();
        assert!(isolated_editor_home(&alias, &real).is_err());
    }
}
