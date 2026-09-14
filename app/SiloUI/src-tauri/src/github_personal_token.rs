//! Personal tokens are independent of App OAuth. Only host runtime profiles receive the value.
use super::*;
use std::collections::HashMap;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
struct PersonalToken {
    token: String,
    account: String,
}
static TOKEN_OPERATION: Mutex<()> = Mutex::new(());
static SECRET: SessionSecret<Option<PersonalToken>> = SessionSecret::new();
static STATUS: Mutex<Option<Value>> = Mutex::new(None);
static CHECK_AT: AtomicU64 = AtomicU64::new(0);
static APPLIED: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

pub(super) fn selected(policy: &Value) -> bool {
    policy["authenticationMethod"] == "token"
}
fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("org.silo.Silo.github", "personal-token")
        .map_err(|_| "The system credential store is unavailable.".into())
}
fn read() -> Result<Option<PersonalToken>, String> {
    SECRET.read(|| match entry()?.get_password() {
        Ok(value) => {
            serde_json::from_str(&value).map_err(|_| "Stored GitHub token is invalid.".into())
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Cannot read the GitHub token from the system credential store.".into()),
    })
}
pub(super) fn status() -> Value {
    STATUS
        .lock()
        .ok()
        .and_then(|s| s.clone())
        .unwrap_or_else(|| json!({"state":"disconnected","saved":false}))
}
pub(super) fn connected() -> bool {
    status()["state"] == "connected"
}
fn publish(value: Value) -> bool {
    let mut state = STATUS.lock().unwrap_or_else(|e| e.into_inner());
    let changed = state.as_ref() != Some(&value);
    *state = Some(value);
    changed
}
fn validated(token: &str) -> Result<PersonalToken, String> {
    validated_with(token, |token| github(token, "/user"))
}
fn validated_with(
    token: &str,
    lookup: impl FnOnce(&str) -> Result<Value, String>,
) -> Result<PersonalToken, String> {
    if token.is_empty()
        || token.len() > 4096
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return Err("Enter a valid GitHub personal access token.".into());
    }
    let user = lookup(token).map_err(|_| {
        "Could not validate the GitHub token. Check its validity and your connection.".to_string()
    })?;
    let account = user["login"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 100)
        .ok_or("GitHub did not identify this token's account.")?;
    Ok(PersonalToken {
        token: token.into(),
        account: account.into(),
    })
}
pub(super) fn value() -> Result<String, String> {
    if !connected() {
        return Err(
            "The personal token is disconnected. Add or replace it in GitHub settings.".into(),
        );
    }
    read()?
        .map(|t| t.token)
        .ok_or("Add a personal token in GitHub settings.".into())
}
fn fingerprint(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}
fn applied() -> &'static Mutex<HashMap<String, String>> {
    APPLIED.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) fn apply(app: &tauri::AppHandle, name: &str, revision: u64) -> Result<(), String> {
    let _state = STATE.lock().map_err(|_| "GitHub state is unavailable.")?;
    let d = load(app)?;
    if d.revision != revision {
        return Err("GitHub access changed. Applying your latest choices.".into());
    }
    let token = value()?;
    let profile = json!({"version":2,"owners":[],"personalToken":token});
    if crate::runtime::github_policy_is_cached(app, name, &profile)?
        && applied()
            .lock()
            .map_err(|_| "GitHub token state is unavailable.")?
            .get(&active_key(app, name)?)
            == Some(&fingerprint(&token))
    {
        return Ok(());
    }
    crate::runtime::apply_github_policy(app, name, revision, &profile)?;
    applied()
        .lock()
        .map_err(|_| "GitHub token state is unavailable.")?
        .insert(active_key(app, name)?, fingerprint(&token));
    active()
        .lock()
        .map_err(|_| "GitHub state is unavailable.")?
        .remove(&active_key(app, name)?);
    Ok(())
}

/// Remove token authority before a method switch, removal, failed validation or replacement.
/// OAuth reconciliation never substitutes its own credential for a disconnected personal token.
pub(super) fn narrow(app: &tauri::AppHandle, d: &Document) -> Result<(), String> {
    let prefix = format!("{}:", path(app)?.display());
    let cached = applied()
        .lock()
        .map_err(|_| "GitHub token state is unavailable.")?
        .clone();
    let current = value().ok().map(|token| fingerprint(&token));
    for (key, attached) in cached.iter().filter(|(key, _)| key.starts_with(&prefix)) {
        let name = &key[prefix.len()..];
        let keep = d
            .workspaces
            .iter()
            .any(|w| w["workspace"] == name && selected(w))
            && current.as_ref() == Some(attached);
        if !keep {
            crate::runtime::apply_github_policy(app, name, d.revision, &profile(&[]))?;
            applied()
                .lock()
                .map_err(|_| "GitHub token state is unavailable.")?
                .remove(key);
        }
    }
    // A surviving runtime may still hold a token from the preceding app process.
    if d.session != session() {
        for w in d.workspaces.iter().filter(|w| selected(w)) {
            let name = w["workspace"].as_str().ok_or("Invalid sandbox policy.")?;
            applied()
                .lock()
                .map_err(|_| "GitHub token state is unavailable.")?
                .entry(active_key(app, name)?)
                .or_insert_with(|| "unverified".into());
            crate::runtime::apply_github_policy(app, name, d.revision, &profile(&[]))?;
            applied()
                .lock()
                .map_err(|_| "GitHub token state is unavailable.")?
                .remove(&active_key(app, name)?);
        }
    }
    Ok(())
}
fn changed(app: &tauri::AppHandle, removing: Option<bool>) -> Result<(), String> {
    let _state = STATE.lock().map_err(|_| "GitHub state is unavailable.")?;
    let mut d = load(app)?;
    if let Some(removing) = removing {
        d.personal_token_removing = removing;
    }
    d.revision += 1;
    let names: Vec<_> = d
        .workspaces
        .iter()
        .filter(|w| selected(w))
        .filter_map(|w| w["workspace"].as_str().map(str::to_owned))
        .collect();
    for name in &names {
        if !d.access_pending.contains(name) {
            d.access_pending.push(name.clone());
        }
    }
    mark_pending_for(&mut d, &names);
    save(app, &d)?;
    let result = narrow(app, &d);
    schedule(Duration::ZERO);
    let _ = app.emit("silo://application-state-changed", ());
    result
}

/// Called by the existing serialized worker. Snapshot reads never touch secure storage.
pub(super) fn check(app: &tauri::AppHandle) {
    let Ok(_operation) = TOKEN_OPERATION.try_lock() else {
        return;
    };
    if now() < CHECK_AT.load(Ordering::SeqCst) {
        return;
    }
    CHECK_AT.store(now() + 300, Ordering::SeqCst);
    let removing = load(app).map(|d| d.personal_token_removing).unwrap_or(true);
    let next = if removing {
        json!({"state":"disconnected","saved":true,"message":"Token removal is pending. Retry Remove token."})
    } else {
        match read() {
            Ok(Some(token)) => match validated(&token.token) {
                Ok(token) => json!({"state":"connected","saved":true,"account":token.account}),
                Err(message) => {
                    CHECK_AT.store(now() + 30, Ordering::SeqCst);
                    json!({"state":"disconnected","saved":true,"message":message})
                }
            },
            Ok(None) => json!({"state":"disconnected","saved":false}),
            Err(message) => json!({"state":"disconnected","saved":true,"message":message}),
        }
    };
    if publish(next) {
        if let Err(message) = changed(app, None) {
            // Keep the failed detachment visible and retry it through the normal worker.
            let _state = STATE.lock().ok();
            if let Ok(mut d) = load(app) {
                for name in d
                    .workspaces
                    .iter()
                    .filter(|w| selected(w))
                    .filter_map(|w| w["workspace"].as_str())
                {
                    d.access_errors.insert(name.into(), message.clone());
                }
                let _ = save(app, &d);
            }
        }
    }
}

#[tauri::command]
pub async fn save_github_personal_token(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    token: String,
) -> Result<Value, String> {
    require_main(window.label())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _update = crate::updates::operation_guard()?;
        let _network = TOKEN_OPERATION
            .lock()
            .map_err(|_| "GitHub operation failed.")?;
        let token = validated(token.trim())?;
        SECRET.retry();
        SECRET.write(Some(token.clone()), || {
            entry()?
                .set_password(
                    &serde_json::to_string(&token).map_err(|_| "Cannot encode GitHub token.")?,
                )
                .map_err(|_| "Cannot save GitHub token in the system credential store.".into())
        })?;
        publish(json!({"state":"connected","saved":true,"account":token.account}));
        CHECK_AT.store(now() + 300, Ordering::SeqCst);
        changed(&app, Some(false))?;
        snapshot(&app)
    })
    .await
    .map_err(|_| "Could not save GitHub token.")?
}
#[tauri::command]
pub async fn remove_github_personal_token(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Value, String> {
    require_main(window.label())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _update = crate::updates::operation_guard()?;
        let _network = TOKEN_OPERATION
            .lock()
            .map_err(|_| "GitHub operation failed.")?;
        // Detach before deletion so a storage failure cannot leave guest access silently enabled.
        publish(json!({"state":"disconnected","saved":true,"message":"Removing personal token."}));
        changed(&app, Some(true))?;
        SECRET.retry();
        SECRET.write(None, || match entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("Cannot remove GitHub token from the system credential store.".into()),
        })?;
        publish(json!({"state":"disconnected","saved":false}));
        CHECK_AT.store(now() + 300, Ordering::SeqCst);
        changed(&app, Some(false))?;
        snapshot(&app)
    })
    .await
    .map_err(|_| "Could not remove GitHub token.")?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn empty_account_connects_without_repository_discovery() {
        let token = validated_with("github_pat_synthetic", |_| {
            Ok(json!({"login":"new-user","public_repos":0}))
        })
        .unwrap();
        assert_eq!(token.account, "new-user");
    }
    #[test]
    fn validation_does_not_echo_tokens_or_upstream_errors() {
        let error = validated_with("github_pat_synthetic", |_| {
            Err("github_pat_synthetic private response".into())
        })
        .err()
        .unwrap();
        assert!(!error.contains("github_pat_synthetic"));
        assert!(!error.contains("private response"));
        assert!(
            validated_with("a\r\nAuthorization: bad", |_| panic!("invalid token sent")).is_err()
        );
    }
    #[test]
    fn method_switch_requires_only_its_selected_connection() {
        let token = json!({"authenticationMethod":"token"});
        let oauth = json!({"authenticationMethod":"oauth"});
        assert!(validate_method_change(None, &token, true, false).is_err());
        assert!(validate_method_change(None, &token, false, true).is_ok());
        assert!(validate_method_change(Some(&token), &oauth, false, true).is_err());
        assert!(validate_method_change(Some(&token), &oauth, true, false).is_ok());
        // Existing unavailable choices are preserved during unrelated identity edits.
        assert!(validate_method_change(Some(&token), &token, false, false).is_ok());
        assert!(validate_method_change(None, &oauth, false, false).is_ok());
    }
    #[test]
    fn legacy_policies_stay_oauth_and_token_policy_has_no_oauth_scopes() {
        assert!(!selected(&json!({})));
        assert!(selected(&json!({"authenticationMethod":"token"})));
        let d = Document {
            access_enabled: true,
            repositories: vec![json!({"id":1,"ownerId":1,"name":"owner/repo"})],
            ..Document::default()
        };
        assert!(scopes(
            &d,
            &json!({"authenticationMethod":"token","repositoryMode":"all","repositories":[]})
        )
        .unwrap()
        .is_empty());
    }
}
