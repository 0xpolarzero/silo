//! Host-only GitHub account and durable desired policy. No credential is exposed by a command.
use crate::github_tokens::{Configuration, Operation};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Condvar, Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};

static OPERATION: Mutex<()> = Mutex::new(());
// Never hold this lock during a GitHub request. It orders desired saves
// and local profile attachment so an older network result cannot restore access.
static STATE: Mutex<()> = Mutex::new(());
static ACTIVE: OnceLock<Mutex<std::collections::HashMap<String, Vec<RuntimeGrant>>>> =
    OnceLock::new();
#[derive(Clone)]
struct IssuedToken {
    owner: u64,
    all: bool,
    write: bool,
    ids: Vec<u64>,
    token: String,
    expires_at: u64,
}
static ISSUED: OnceLock<Mutex<std::collections::HashMap<String, Vec<IssuedToken>>>> =
    OnceLock::new();
fn issued() -> &'static Mutex<std::collections::HashMap<String, Vec<IssuedToken>>> {
    ISSUED.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}
fn issued_matches(token: &IssuedToken, scope: &GrantScope, write: bool) -> bool {
    token.owner == scope.owner
        && token.all == scope.all
        && token.write == write
        && (scope.all
            || token.ids
                == if write {
                    scope.writes.clone()
                } else {
                    scope.ids.clone()
                })
        && token.expires_at > now() + 120
}
static PENDING: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
fn schedule(delay: Duration) {
    if let Ok(mut pending) = PENDING.get_or_init(|| Mutex::new(None)).lock() {
        *pending = Some(Instant::now() + delay);
    }
}
fn active() -> &'static Mutex<std::collections::HashMap<String, Vec<RuntimeGrant>>> {
    ACTIVE.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}
fn active_key(app: &tauri::AppHandle, workspace: &str) -> Result<String, String> {
    Ok(format!("{}:{workspace}", path(app)?.display()))
}
static SESSION: OnceLock<String> = OnceLock::new();
fn session() -> &'static str {
    SESSION.get_or_init(|| uuid::Uuid::new_v4().to_string())
}
static CONNECTING: AtomicBool = AtomicBool::new(false);
static CANCELLATION: AtomicU64 = AtomicU64::new(0);
// Policy edits keep their submission order even if spawn_blocking starts its
// jobs out of order. This queue contains local updates only, never HTTP calls.
struct IntentQueue {
    issued: AtomicU64,
    turn: Mutex<u64>,
    ready: Condvar,
}
impl IntentQueue {
    const fn new() -> Self {
        Self {
            issued: AtomicU64::new(0),
            turn: Mutex::new(1),
            ready: Condvar::new(),
        }
    }
    fn ticket(&self) -> u64 {
        self.issued.fetch_add(1, Ordering::SeqCst) + 1
    }
    fn wait(&self, ticket: u64) -> Result<IntentTurn<'_>, String> {
        let mut turn = self
            .turn
            .lock()
            .map_err(|_| "GitHub settings queue is unavailable.")?;
        while *turn != ticket {
            turn = self
                .ready
                .wait(turn)
                .map_err(|_| "GitHub settings queue is unavailable.")?;
        }
        Ok(IntentTurn(self))
    }
}
struct IntentTurn<'a>(&'a IntentQueue);
impl Drop for IntentTurn<'_> {
    fn drop(&mut self) {
        if let Ok(mut turn) = self.0.turn.lock() {
            *turn += 1;
            self.0.ready.notify_all();
        }
    }
}
static INTENTS: IntentQueue = IntentQueue::new();
struct Connecting(tauri::AppHandle);
impl Drop for Connecting {
    fn drop(&mut self) {
        CONNECTING.store(false, Ordering::SeqCst);
        let _ = self.0.emit("silo://application-state-changed", ());
    }
}
const CLIENT_SECRET: Option<&str> = option_env!("SILO_GITHUB_CLIENT_SECRET");
const CLIENT_ID: Option<&str> = option_env!("SILO_GITHUB_CLIENT_ID");
const APP_SLUG: Option<&str> = option_env!("SILO_GITHUB_APP_SLUG");

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Credential {
    access_token: String,
    refresh_token: Option<String>,
    expires_at: u64,
}
// Snapshot reads never open the credential store or wait for its permission UI.
// This observation contains public lifetime/error metadata only, never a token.
type CredentialObservation = Option<Result<Option<u64>, String>>;
static CREDENTIAL_OBSERVATION: Mutex<CredentialObservation> = Mutex::new(None);
static OBSERVATION_APP: OnceLock<tauri::AppHandle> = OnceLock::new();
fn publish_credential_observation(value: Result<Option<u64>, String>) {
    if let Ok(mut observed) = CREDENTIAL_OBSERVATION.lock() {
        if observed.as_ref() == Some(&value) {
            return;
        }
        *observed = Some(value);
    }
    if let Some(app) = OBSERVATION_APP.get() {
        let _ = app.emit("silo://application-state-changed", ());
    }
}
fn observe_credential_read(
    read: impl FnOnce() -> Result<Option<Credential>, String>,
    publish: impl FnOnce(Result<Option<u64>, String>),
) -> Result<Option<Credential>, String> {
    let result = read();
    publish(
        result
            .as_ref()
            .map(|c| c.as_ref().map(|c| c.expires_at))
            .map_err(Clone::clone),
    );
    result
}
fn observed_credential() -> CredentialObservation {
    CREDENTIAL_OBSERVATION
        .lock()
        .map(|state| state.clone())
        .unwrap_or_else(|_| Some(Err("GitHub credential state is unavailable.".into())))
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Document {
    revision: u64,
    access_enabled: bool,
    account: Option<String>,
    #[serde(default)]
    workspaces: Vec<Value>,
    #[serde(default)]
    repositories: Vec<Value>,
    #[serde(default)]
    operations: Vec<Value>,
    #[serde(default)]
    session: String,
    #[serde(default)]
    refresh_at: u64,
    #[serde(default)]
    catalog_error: Option<String>,
    #[serde(default)]
    catalog_refresh_at: u64,
    #[serde(default)]
    grants_issued: bool,
    #[serde(default)]
    identity_errors: std::collections::HashMap<String, String>,
    #[serde(default)]
    identity_pending: Vec<String>,
    #[serde(default)]
    access_pending: Vec<String>,
    #[serde(default)]
    access_errors: std::collections::HashMap<String, String>,
    #[serde(default)]
    disconnect_pending: bool,
    #[serde(default)]
    rate_retry_at: u64,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn delete_account_credential() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {
            *PENDING_REFRESH
                .lock()
                .map_err(|_| "GitHub credential state is unavailable.")? = None;
            publish_credential_observation(Ok(None));
            Ok(())
        }
        Err(_) => {
            let message =
                "Cannot remove GitHub credentials from the system credential store.".to_string();
            publish_credential_observation(Err(message.clone()));
            Err(message)
        }
    }
}
fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("org.silo.Silo.github", "account")
        .map_err(|_| "The system credential store is unavailable.".into())
}
fn credential() -> Result<Option<Credential>, String> {
    observe_credential_read(|| read_entry(&entry()?), publish_credential_observation)
}
fn read_entry(entry: &keyring::Entry) -> Result<Option<Credential>, String> {
    match entry.get_password() {
        Ok(s) => serde_json::from_str(&s)
            .map(Some)
            .map_err(|_| "Stored GitHub credentials are invalid. Reconnect GitHub.".into()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Cannot read GitHub credentials from the system credential store.".into()),
    }
}
fn store(c: &Credential) -> Result<(), String> {
    let result = entry().and_then(|entry| store_entry(&entry, c));
    publish_credential_observation(
        result
            .as_ref()
            .map(|_| Some(c.expires_at))
            .map_err(Clone::clone),
    );
    result
}
fn store_entry(entry: &keyring::Entry, c: &Credential) -> Result<(), String> {
    entry
        .set_password(&serde_json::to_string(c).map_err(|_| "Cannot encode GitHub credentials.")?)
        .map_err(|_| "Cannot save GitHub credentials in the system credential store.".into())
}
fn path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|_| "Cannot locate application data.")?
        .join("github.json"))
}
fn load(app: &tauri::AppHandle) -> Result<Document, String> {
    match fs::read(path(app)?) {
        Ok(b) if b.len() <= 16 * 1024 * 1024 => {
            serde_json::from_slice(&b).map_err(|_| "GitHub configuration is invalid.".into())
        }
        Ok(_) => Err("GitHub configuration exceeds the supported size.".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Document::default()),
        Err(_) => Err("Cannot read GitHub configuration.".into()),
    }
}
fn save(app: &tauri::AppHandle, d: &Document) -> Result<(), String> {
    let mut saved = d.clone();
    saved.rate_retry_at = saved.rate_retry_at.max(crate::github_http::retry_floor());
    let d = &saved;
    let p = path(app)?;
    let parent = p.parent().ok_or("Missing configuration directory.")?;
    fs::create_dir_all(parent).map_err(|_| "Cannot create configuration directory.")?;
    let mut f = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| "Cannot write GitHub configuration.")?;
    f.write_all(&serde_json::to_vec(d).map_err(|_| "Cannot encode GitHub configuration.")?)
        .map_err(|_| "Cannot write GitHub configuration.")?;
    f.as_file()
        .sync_all()
        .map_err(|_| "Cannot sync GitHub configuration.")?;
    f.persist(&p)
        .map_err(|_| "Cannot save GitHub configuration.")?;
    fs::File::open(parent)
        .and_then(|f| f.sync_all())
        .map_err(|_| "Cannot sync GitHub configuration directory.".to_string())?;
    let _ = app.emit("silo://application-state-changed", ());
    Ok(())
}
fn token_configuration() -> Result<Configuration, String> {
    Ok(Configuration {
        client_id: CLIENT_ID
            .filter(|v| !v.is_empty())
            .ok_or("GitHub connection is not configured in this build.")?
            .into(),
        client_secret: CLIENT_SECRET
            .filter(|v| !v.is_empty())
            .ok_or("GitHub connection is not configured in this build.")?
            .into(),
    })
}
fn token_operation(operation: Operation, body: Value) -> Result<Value, String> {
    crate::github_tokens::execute(&token_configuration()?, operation, body)
}
fn from_response(v: Value) -> Result<Credential, String> {
    let token = v["accessToken"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("GitHub returned no access credential.")?;
    Ok(Credential {
        access_token: token.into(),
        refresh_token: v["refreshToken"].as_str().map(str::to_owned),
        expires_at: now()
            .checked_add(
                v["expiresIn"]
                    .as_u64()
                    .filter(|n| *n > 0 && *n <= 86400)
                    .ok_or("GitHub returned an invalid credential lifetime.")?,
            )
            .ok_or("GitHub credential expiration overflow.")?,
    })
}
struct PendingRefresh {
    previous_access: String,
    renewed: Credential,
}
static PENDING_REFRESH: Mutex<Option<PendingRefresh>> = Mutex::new(None);

fn revocation_credential() -> Result<Option<Credential>, String> {
    let current = credential()?;
    let pending = PENDING_REFRESH
        .lock()
        .map_err(|_| "GitHub credential state is unavailable.")?;
    Ok(current.map(|current| {
        pending
            .as_ref()
            .filter(|p| p.previous_access == current.access_token)
            .map_or(current, |p| p.renewed.clone())
    }))
}

fn active_credential() -> Result<Credential, String> {
    let current = credential()?.ok_or("Connect GitHub first.")?;
    let mut pending = PENDING_REFRESH
        .lock()
        .map_err(|_| "GitHub credential state is unavailable.")?;
    refresh_credential_with(
        current,
        &mut pending,
        now(),
        |refresh| {
            from_response(token_operation(
                Operation::Refresh,
                json!({"refreshToken":refresh}),
            )?)
        },
        store,
    )
}

fn refresh_credential_with(
    current: Credential,
    pending: &mut Option<PendingRefresh>,
    at: u64,
    renew: impl FnOnce(&str) -> Result<Credential, String>,
    mut persist: impl FnMut(&Credential) -> Result<(), String>,
) -> Result<Credential, String> {
    if pending
        .as_ref()
        .is_some_and(|p| p.previous_access != current.access_token)
    {
        *pending = None;
    }
    if let Some(refresh) = pending.as_ref() {
        // GitHub already rotated the credential. Retry secure storage only,
        // never submit the consumed refresh token to GitHub a second time.
        persist(&refresh.renewed)?;
        return Ok(pending.take().unwrap().renewed);
    }
    if current.expires_at > at + 120 {
        return Ok(current);
    }
    let token = current
        .refresh_token
        .as_deref()
        .ok_or("GitHub access expired. Reconnect GitHub.")?;
    let renewed = renew(token)?;
    *pending = Some(PendingRefresh {
        previous_access: current.access_token,
        renewed,
    });
    persist(&pending.as_ref().unwrap().renewed)?;
    Ok(pending.take().unwrap().renewed)
}

fn github(token: &str, path: &str) -> Result<Value, String> {
    crate::github_http::github(token, path)
}
fn catalog(c: &Credential) -> Result<Vec<Value>, String> {
    Ok(catalog_installations(c)?.0)
}
fn catalog_installations(c: &Credential) -> Result<(Vec<Value>, bool), String> {
    let slug = APP_SLUG.ok_or("GitHub App is not configured in this build.")?;
    let mut repos = Vec::new();
    let mut installed = false;
    for page in 1..=1000 {
        let v = github(
            &c.access_token,
            &format!("/user/installations?per_page=100&page={page}"),
        )?;
        let items = v["installations"]
            .as_array()
            .ok_or("Invalid GitHub installation catalog.")?;
        for i in items
            .iter()
            .filter(|i| i["app_slug"].as_str() == Some(slug))
        {
            installed = true;
            let id = i["id"]
                .as_u64()
                .ok_or("Invalid GitHub installation identifier.")?;
            for p in 1..=1000 {
                let r = github(
                    &c.access_token,
                    &format!("/user/installations/{id}/repositories?per_page=100&page={p}"),
                )?;
                let list = r["repositories"]
                    .as_array()
                    .ok_or("Invalid GitHub repository catalog.")?;
                repos.extend(list.iter().map(
                    |r| json!({"id":r["id"],"ownerId":r["owner"]["id"],"name":r["full_name"]}),
                ));
                if list.len() < 100 {
                    break;
                }
                if p == 1000 {
                    return Err("GitHub repository catalog exceeds the supported size.".into());
                }
            }
        }
        if items.len() < 100 {
            repos.sort_by_key(|repo| repo["id"].as_u64().unwrap_or(0));
            return Ok((repos, installed));
        }
    }
    Err("GitHub installation catalog exceeds the supported size.".into())
}

pub fn snapshot(app: &tauri::AppHandle) -> Result<Value, String> {
    Ok(observed_snapshot(
        load(app)?,
        observed_credential(),
        crate::host_identity::read(),
    ))
}
fn observed_snapshot(
    document: Document,
    observed: CredentialObservation,
    identity: Option<crate::host_identity::HostIdentity>,
) -> Value {
    let waiting = observed.is_none();
    let mut value = public_snapshot(
        document,
        observed
            .unwrap_or_else(|| Err("Waiting for access to the system credential store.".into())),
        identity,
    );
    if waiting {
        value["repositoryCatalogStatus"]["canRetry"] = json!(false);
    }
    value
}
fn public_snapshot(
    mut d: Document,
    stored: Result<Option<u64>, String>,
    identity: Option<crate::host_identity::HostIdentity>,
) -> Value {
    let connected = match stored {
        Ok(expires_at) => expires_at.is_some_and(|expiry| expiry > now()),
        Err(message) => {
            d.catalog_error = Some(message);
            false
        }
    };
    if d.session != session() {
        d.operations = d.workspaces.iter().map(|w|json!({"workspace":w["workspace"],"status":"failed","message":"GitHub access must be verified for this app session.","canRetry":true})).collect();
    }

    json!({"policyRevision":d.revision,"state":if CONNECTING.load(Ordering::SeqCst){"connecting"}else if connected{"connected"}else{"disconnected"},"account":d.account,"accessEnabled":d.access_enabled,"hostIdentity":identity,"repositoryCatalog":d.repositories.iter().filter_map(|r|r["name"].as_str()).collect::<Vec<_>>(),"repositoryCatalogStatus":match &d.catalog_error { Some(message)=>json!({"status":"unavailable","message":message,"canRetry":true}),None=>json!({"status":"available"})},"workspaces":d.workspaces,"workspaceOperations":d.operations})
}
type TokenLedger = std::collections::HashMap<String, Vec<String>>;
fn ledger_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("org.silo.Silo.github", "runtime-grants")
        .map_err(|_| "The system credential store is unavailable.".into())
}
fn read_ledger(entry: &keyring::Entry) -> Result<TokenLedger, String> {
    match entry.get_password() {
        Ok(secret) => serde_json::from_str(&secret)
            .map_err(|_| "Stored GitHub runtime credentials are invalid.".into()),
        Err(keyring::Error::NoEntry) => Ok(TokenLedger::new()),
        Err(_) => {
            Err("Cannot read GitHub runtime credentials from the system credential store.".into())
        }
    }
}
fn save_ledger(entry: &keyring::Entry, ledger: &TokenLedger) -> Result<(), String> {
    entry
        .set_password(
            &serde_json::to_string(ledger)
                .map_err(|_| "Cannot encode GitHub runtime credentials.")?,
        )
        .map_err(|_| {
            "Cannot save GitHub runtime credentials in the system credential store.".into()
        })
}
// Record each successful issuance before making another network request. A
// later partial failure must not lose the only copy needed for revocation.
fn remember_token(app: &tauri::AppHandle, workspace: &str, token: &str) -> Result<(), String> {
    let entry = ledger_entry()?;
    let mut ledger = read_ledger(&entry)?;
    let tokens = ledger.entry(workspace.into()).or_default();
    if !tokens.iter().any(|previous| previous == token) {
        tokens.push(token.into());
    }
    save_ledger(&entry, &ledger)?;
    let _state = STATE.lock().map_err(|_| "GitHub state is unavailable.")?;
    let mut document = load(app)?;
    document.grants_issued = true;
    save(app, &document)
}
fn profile(grants: &[RuntimeGrant]) -> Value {
    json!({"version":1,"owners":grants.iter().filter(|g| !g.read_token.is_empty()).map(|g|json!({"login":g.owner_login,"repositoryIds":g.repository_ids,"readToken":g.read_token,"writeToken":g.write_token,"expiresAt":g.expires_at})).collect::<Vec<_>>()})
}
fn retire_unused(app: &tauri::AppHandle, workspace: &str) -> Result<(), String> {
    let key = active_key(app, workspace)?;
    let retained: Vec<String> = active()
        .lock()
        .map_err(|_| "GitHub state is unavailable.")?
        .get(&key)
        .into_iter()
        .flatten()
        .flat_map(|g| std::iter::once(g.read_token.clone()).chain(g.write_token.clone()))
        .collect();
    let mut live = crate::runtime::scoped_cached_tokens(app, workspace)?;
    live.extend(retained);
    let d = load(app)?;
    let scopes = d
        .workspaces
        .iter()
        .find(|w| w["workspace"].as_str() == Some(workspace))
        .and_then(|w| scopes(&d, w).ok())
        .unwrap_or_default();
    if let Some(tokens) = issued()
        .lock()
        .map_err(|_| "GitHub state is unavailable.")?
        .get_mut(&key)
    {
        tokens.retain(|token| {
            scopes.iter().any(|scope| {
                issued_matches(token, scope, token.write)
                    && (!token.write || !scope.writes.is_empty())
            })
        });
        live.extend(tokens.iter().map(|token| token.token.clone()));
    }
    let entry = ledger_entry()?;
    let mut ledger = read_ledger(&entry)?;
    let tokens = ledger.get(workspace).cloned().unwrap_or_default();
    let mut failure = None;
    let mut remaining = Vec::new();
    for token in tokens {
        if live.contains(&token) {
            remaining.push(token);
            continue;
        }
        match token_operation(Operation::RevokeToken, json!({"accessToken":token})) {
            Ok(_) => {}
            Err(message) => {
                failure = Some(message);
                remaining.push(token);
            }
        }
    }
    if remaining.is_empty() {
        ledger.remove(workspace);
    } else {
        ledger.insert(workspace.into(), remaining);
    }
    save_ledger(&entry, &ledger)?;
    failure.map_or(Ok(()), Err)
}
fn finish_application(
    grants: Result<(), String>,
    explicit: bool,
    previous_error: Option<&str>,
    write: impl FnOnce() -> Result<(), String>,
) -> (Result<(), String>, Result<(), String>) {
    let identity = if explicit {
        write()
    } else {
        previous_error.map_or(Ok(()), |message| Err(message.into()))
    };
    let combined = match (grants, &identity) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(access), Err(identity)) => Err(format!("{access} Git identity: {identity}")),
        (Err(message), Ok(())) => Err(message),
        (Ok(()), Err(message)) => Err(message.clone()),
    };
    (combined, identity)
}

fn access_update_due(d: &Document, name: &str, at: u64) -> bool {
    d.access_pending.iter().any(|n| n == name) || d.session != session() || at >= d.refresh_at
}
fn worker_due(d: &Document, pending: Option<Instant>, at: u64, instant: Instant) -> bool {
    match pending {
        Some(deadline) => instant >= deadline,
        None => d.session != session() || at >= d.refresh_at || catalog_refresh_due(d, at),
    }
}
fn apply(
    app: &tauri::AppHandle,
    _document: &mut Document,
    workspace: Option<&str>,
    apply_identity: bool,
) -> Result<(), String> {
    let d = {
        let _state = STATE.lock().map_err(|_| "GitHub state is unavailable.")?;
        load(app)?
    };
    let mut refresh_at = if now() < d.refresh_at {
        d.refresh_at
    } else {
        now() + 3600
    };
    for w in &d.workspaces {
        let name = w["workspace"].as_str().ok_or("Invalid sandbox policy.")?;
        if workspace.is_some_and(|target| target != name) {
            continue;
        }
        // Identity changes are independent of token issuance, including offline edits.
        let identity_requested = apply_identity || d.identity_pending.iter().any(|n| n == name);
        if identity_requested {
            let _state = STATE.lock().map_err(|_| "GitHub state is unavailable.")?;
            if load(app)?.revision != d.revision {
                schedule(Duration::from_millis(500));
                return Ok(());
            }
            let result = crate::runtime::apply_github_identity(app, name, &w["identity"]);
            let mut current = load(app)?;
            current.identity_pending.retain(|n| n != name);
            match result {
                Ok(()) => {
                    current.identity_errors.remove(name);
                }
                Err(error) => {
                    current.identity_errors.insert(name.into(), error);
                }
            }
            save(app, &current)?;
        }
        let key = active_key(app, name)?;
        let previous = active()
            .lock()
            .map_err(|_| "GitHub state is unavailable.")?
            .get(&key)
            .cloned()
            .unwrap_or_default();
        let access_requested = access_update_due(&d, name, now());
        let result = if access_requested {
            let result = runtime_grants_for(app, &d, w, &previous).and_then(|grants| {
                let _state = STATE.lock().map_err(|_| "GitHub state is unavailable.")?;
                if load(app)?.revision != d.revision {
                    return Err("GitHub access changed. Applying your latest choices.".into());
                }
                if let Some(expiry) = grants.iter().map(|g| g.expires_at).min() {
                    refresh_at = refresh_at.min(expiry.saturating_sub(120));
                }
                // Comparing credentials too avoids reconnecting unchanged sessions.
                if grants != previous || d.session != session() {
                    crate::runtime::apply_github_policy(app, name, d.revision, &profile(&grants))?;
                    active()
                        .lock()
                        .map_err(|_| "GitHub state is unavailable.")?
                        .insert(key, grants);
                }
                Ok(())
            });
            let retirement = if d.grants_issued || load(app)?.grants_issued {
                retire_unused(app, name)
            } else {
                Ok(())
            };
            result.and(retirement)
        } else {
            d.access_errors
                .get(name)
                .map_or(Ok(()), |message| Err(message.clone()))
        };
        let _state = STATE.lock().map_err(|_| "GitHub state is unavailable.")?;
        let mut current = load(app)?;
        if current.revision != d.revision {
            schedule(Duration::from_millis(500));
            return Ok(());
        }
        if access_requested {
            current.access_pending.retain(|n| n != name);
            match &result {
                Ok(()) => {
                    current.access_errors.remove(name);
                }
                Err(error) => {
                    current.access_errors.insert(name.into(), error.clone());
                }
            }
        }
        let result = finish_application(
            result,
            false,
            current.identity_errors.get(name).map(String::as_str),
            || Ok(()),
        )
        .0;
        let operation = match result {
            Ok(()) => {
                json!({"workspace":name,"status":"succeeded","message":"GitHub access verified."})
            }
            Err(message) => {
                let retry = crate::github_http::retry_at();
                refresh_at = refresh_at.min(if retry > 0 {
                    retry.max(now() + 1)
                } else {
                    now() + 300
                });
                json!({"workspace":name,"status":"failed","message":message,"canRetry":true})
            }
        };
        current
            .operations
            .retain(|op| op["workspace"].as_str() != Some(name));
        current.operations.push(operation);
        current.session = session().into();
        current.refresh_at = refresh_at;
        save(app, &current)?;
    }
    Ok(())
}

fn validate(workspaces: &[Value]) -> Result<(), String> {
    if workspaces.len() > 64 {
        return Err("Too many sandbox policies.".into());
    };
    let mut names = std::collections::HashSet::new();
    for w in workspaces {
        let fields = w.as_object().ok_or("Invalid sandbox policy.")?;
        if fields.keys().any(|k| {
            ![
                "workspace",
                "identity",
                "repositories",
                "repositoryMode",
                "allRepositoriesAllowChanges",
            ]
            .contains(&k.as_str())
        }) {
            return Err("Unknown sandbox policy field.".into());
        }
        if serde_json::to_vec(w).map_or(true, |b| b.len() > 1024 * 1024) {
            return Err("Sandbox policy is too large.".into());
        }
        let name = w["workspace"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 200)
            .ok_or("Missing sandbox name.")?;
        crate::runtime::validate_name(name).map_err(|error| error.to_string())?;
        let identity = w["identity"]
            .as_object()
            .ok_or("Missing Git identity settings.")?;
        if identity
            .keys()
            .any(|key| !["name", "email", "apply"].contains(&key.as_str()))
            || !w["identity"]["apply"].is_boolean()
            || ["name", "email"].iter().any(|key| {
                w["identity"][key].as_str().is_none_or(|value| {
                    value.len() > 1024
                        || value.chars().any(char::is_control)
                        || (w["identity"]["apply"] == true && value.trim().is_empty())
                })
            })
        {
            return Err("Invalid Git identity settings.".into());
        }
        if !names.insert(name) {
            return Err("Duplicate sandbox policy.".into());
        };
        if !matches!(w["repositoryMode"].as_str(), Some("all" | "selected")) {
            return Err("Choose selected or all repositories.".into());
        };
        if !w["allRepositoriesAllowChanges"].is_boolean() {
            return Err("Invalid GitHub changes policy.".into());
        };
        let mut repository_names = std::collections::HashSet::new();
        for r in w["repositories"]
            .as_array()
            .ok_or("Invalid repository selection.")?
        {
            if r.as_object().is_none_or(|fields| {
                fields
                    .keys()
                    .any(|key| !["repository", "allowPushes"].contains(&key.as_str()))
            }) {
                return Err("Unknown repository policy field.".into());
            }
            let n = r["repository"].as_str().ok_or("Invalid repository name.")?;
            if !repository_names.insert(n.to_ascii_lowercase())
                || n.split('/').count() != 2
                || n.split('/').any(|part| {
                    part.is_empty()
                        || !part
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
                })
                || !r["allowPushes"].is_boolean()
            {
                return Err("Invalid repository policy.".into());
            }
        }
    }
    Ok(())
}

/// Only the host runtime IPC may serialize these short-lived credentials.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeGrant {
    pub owner_id: u64,
    pub owner_login: String,
    pub repository_ids: Vec<u64>,
    pub read_token: String,
    pub write_token: Option<String>,
    pub write_repository_ids: Vec<u64>,
    pub expires_at: u64,
    pub read_expires_at: u64,
    pub write_expires_at: u64,
    pub all_repositories: bool,
}
fn token_expiry(response: &Value) -> Result<u64, String> {
    let raw = response["expiresAt"]
        .as_str()
        .ok_or("Restricted credential has no expiration.")?;
    let seconds = time::OffsetDateTime::parse(raw, &time::format_description::well_known::Rfc3339)
        .map_err(|_| "Restricted credential expiration is invalid.")?
        .unix_timestamp();
    let seconds = u64::try_from(seconds).map_err(|_| "Restricted credential has expired.")?;
    if seconds <= now() + 120 {
        return Err("Restricted credential expires too soon.".into());
    }
    Ok(seconds)
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct GrantScope {
    owner: u64,
    login: String,
    ids: Vec<u64>,
    writes: Vec<u64>,
    all: bool,
}
fn scopes(d: &Document, policy: &Value) -> Result<Vec<GrantScope>, String> {
    if !d.access_enabled {
        return Ok(Vec::new());
    }
    let all = policy["repositoryMode"].as_str() == Some("all");
    let selected = policy["repositories"]
        .as_array()
        .ok_or("Invalid repository selection.")?;
    if !all
        && selected
            .iter()
            .any(|s| !d.repositories.iter().any(|r| r["name"] == s["repository"]))
    {
        return Err(
            "A selected repository is no longer authorized by GitHub. Update the selection.".into(),
        );
    }
    let mut groups = std::collections::BTreeMap::<u64, GrantScope>::new();
    for repo in &d.repositories {
        let selection = selected.iter().find(|s| s["repository"] == repo["name"]);
        if !all && selection.is_none() {
            continue;
        }
        let owner = repo["ownerId"]
            .as_u64()
            .ok_or("Invalid GitHub owner identifier.")?;
        let id = repo["id"]
            .as_u64()
            .ok_or("Invalid GitHub repository identifier.")?;
        let login = repo["name"]
            .as_str()
            .and_then(|s| s.split('/').next())
            .ok_or("Invalid repository name.")?;
        let group = groups.entry(owner).or_insert_with(|| GrantScope {
            owner,
            login: login.into(),
            ids: vec![],
            writes: vec![],
            all,
        });
        group.ids.push(id);
        if if all {
            policy["allRepositoriesAllowChanges"] == true
        } else {
            selection.is_some_and(|s| s["allowPushes"] == true)
        } {
            group.writes.push(id);
        }
    }
    for group in groups.values_mut() {
        group.ids.sort_unstable();
        group.ids.dedup();
        group.writes.sort_unstable();
        group.writes.dedup();
    }
    Ok(groups.into_values().collect())
}
fn read_matches(g: &RuntimeGrant, s: &GrantScope) -> bool {
    g.owner_id == s.owner
        && g.all_repositories == s.all
        && (s.all || g.repository_ids == s.ids)
        && g.read_expires_at > now() + 120
        && !g.read_token.is_empty()
}
fn write_matches(g: &RuntimeGrant, s: &GrantScope) -> bool {
    g.owner_id == s.owner
        && g.all_repositories == s.all
        && (s.all || g.write_repository_ids == s.writes)
        && g.write_expires_at > now() + 120
        && g.write_token.is_some()
}
fn runtime_grants_for(
    app: &tauri::AppHandle,
    d: &Document,
    policy: &Value,
    previous: &[RuntimeGrant],
) -> Result<Vec<RuntimeGrant>, String> {
    if !d.access_enabled || d.account.is_none() {
        return Ok(Vec::new());
    }
    let desired = scopes(d, policy)?;
    let mut credential = None;
    reconcile_grants(
        &desired,
        previous,
        |scope, write| {
            if credential.is_none() {
                credential = Some(active_credential()?);
            }
            mint(
                app,
                policy["workspace"]
                    .as_str()
                    .ok_or("Invalid sandbox policy.")?,
                credential.as_ref().ok_or("Connect GitHub first.")?,
                scope,
                write,
            )
        },
        || load(app).is_ok_and(|current| current.revision == d.revision),
    )
}
fn reconcile_grants(
    desired: &[GrantScope],
    previous: &[RuntimeGrant],
    mut issue: impl FnMut(&GrantScope, bool) -> Result<(String, u64), String>,
    current: impl Fn() -> bool,
) -> Result<Vec<RuntimeGrant>, String> {
    let mut grants = Vec::new();
    for s in desired {
        if !current() {
            return Err("GitHub access changed. Applying your latest choices.".into());
        }
        let prior = previous.iter().find(|g| g.owner_id == s.owner);
        let (read_token, read_expiry) = if let Some(g) = prior.filter(|g| read_matches(g, s)) {
            (g.read_token.clone(), g.read_expires_at)
        } else {
            issue(s, false)?
        };
        if !current() {
            return Err("GitHub access changed. Applying your latest choices.".into());
        }
        let (write_token, write_expiry) = if s.writes.is_empty() {
            (None, u64::MAX)
        } else if let Some(g) = prior.filter(|g| write_matches(g, s)) {
            (g.write_token.clone(), g.write_expires_at)
        } else {
            let (token, expiry) = issue(s, true)?;
            (Some(token), expiry)
        };
        grants.push(RuntimeGrant {
            owner_id: s.owner,
            owner_login: s.login.clone(),
            repository_ids: s.ids.clone(),
            read_token,
            write_token,
            write_repository_ids: s.writes.clone(),
            expires_at: read_expiry.min(write_expiry),
            read_expires_at: read_expiry,
            write_expires_at: write_expiry,
            all_repositories: s.all,
        });
    }
    Ok(grants)
}

fn mint(
    app: &tauri::AppHandle,
    workspace: &str,
    c: &Credential,
    s: &GrantScope,
    write: bool,
) -> Result<(String, u64), String> {
    let key = active_key(app, workspace)?;
    if let Some(token) = issued()
        .lock()
        .map_err(|_| "GitHub state is unavailable.")?
        .get(&key)
        .and_then(|tokens| tokens.iter().find(|token| issued_matches(token, s, write)))
        .cloned()
    {
        return Ok((token.token, token.expires_at));
    }
    let response = token_operation(
        Operation::Scope,
        json!({"accessToken":c.access_token,"ownerId":s.owner,"repositoryIds":if s.all{vec![]}else if write{s.writes.clone()}else{s.ids.clone()},"allRepositories":s.all,"allowChanges":write}),
    )?;
    let token = response["accessToken"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("GitHub returned no restricted credential.")?
        .to_owned();
    if let Err(error) = remember_token(app, workspace, &token) {
        let _ = token_operation(Operation::RevokeToken, json!({"accessToken":token}));
        return Err(error);
    }
    let expiry = token_expiry(&response)?;
    issued()
        .lock()
        .map_err(|_| "GitHub state is unavailable.")?
        .entry(key)
        .or_default()
        .push(IssuedToken {
            owner: s.owner,
            all: s.all,
            write,
            ids: if write {
                s.writes.clone()
            } else {
                s.ids.clone()
            },
            token: token.clone(),
            expires_at: expiry,
        });
    Ok((token, expiry))
}
// Dropping an entire affected token is necessary: its GitHub scope cannot be
// narrowed locally by changing routing hints, especially for GraphQL requests.
fn narrow(grants: &[RuntimeGrant], desired: &[GrantScope]) -> Vec<RuntimeGrant> {
    grants
        .iter()
        .filter_map(|g| {
            let s = desired.iter().find(|s| s.owner == g.owner_id)?;
            let read_safe = (!g.all_repositories || s.all)
                && (s.all || g.repository_ids.iter().all(|id| s.ids.contains(id)));
            let mut retained = g.clone();
            if !read_safe {
                retained.read_token.clear();
                retained.repository_ids.clear();
                retained.read_expires_at = 0;
            }
            let write_safe = (!g.all_repositories || s.all)
                && (if s.all {
                    !s.writes.is_empty()
                } else {
                    g.write_repository_ids
                        .iter()
                        .all(|id| s.writes.contains(id))
                });
            if !write_safe {
                retained.write_token = None;
                retained.write_repository_ids.clear();
                retained.write_expires_at = u64::MAX;
                retained.expires_at = retained.read_expires_at;
            }
            Some(retained)
        })
        .collect()
}
fn narrow_now(app: &tauri::AppHandle, d: &mut Document) -> Result<(), String> {
    let prefix = format!("{}:", path(app)?.display());
    let mut failure = None;
    if d.session != session() && d.grants_issued {
        for w in &d.workspaces {
            if let Some(name) = w["workspace"].as_str() {
                if !active()
                    .lock()
                    .map_err(|_| "GitHub state is unavailable.")?
                    .contains_key(&active_key(app, name)?)
                {
                    if let Err(error) =
                        crate::runtime::apply_github_policy(app, name, d.revision, &profile(&[]))
                    {
                        failure.get_or_insert(error);
                    }
                }
            }
        }
    }
    let cached = active()
        .lock()
        .map_err(|_| "GitHub state is unavailable.")?
        .clone();
    for (key, previous) in cached.iter().filter(|(key, _)| key.starts_with(&prefix)) {
        let name = &key[prefix.len()..];
        let desired = d
            .workspaces
            .iter()
            .find(|w| w["workspace"].as_str() == Some(name))
            .map(|w| scopes(d, w))
            .transpose()
            .map(Option::unwrap_or_default);
        // A stale catalog or invalid other selection must never preserve access
        // that the user just removed. Detach first, retain the validation error.
        let (retained, validation_error) = narrow_checked(previous, desired);
        if let Some(error) = validation_error {
            failure.get_or_insert(error);
        }
        if retained != *previous {
            if let Err(error) =
                crate::runtime::apply_github_policy(app, name, d.revision, &profile(&retained))
            {
                failure.get_or_insert(error);
                continue;
            }
            active()
                .lock()
                .map_err(|_| "GitHub state is unavailable.")?
                .insert(key.clone(), retained);
        }
    }
    failure.map_or(Ok(()), Err)
}

fn narrow_checked(
    previous: &[RuntimeGrant],
    desired: Result<Vec<GrantScope>, String>,
) -> (Vec<RuntimeGrant>, Option<String>) {
    match desired {
        Ok(scopes) => (narrow(previous, &scopes), None),
        Err(error) => (Vec::new(), Some(error)),
    }
}

/// Explicit host Push only: does not grant write access to the guest or modify its policy.
pub(crate) fn host_push_credential(
    app: &tauri::AppHandle,
    workspace: &str,
    repository: &str,
) -> Result<String, String> {
    let _guard = OPERATION.lock().map_err(|_| "GitHub operation failed.")?;
    let d = load(app)?;
    if !d.access_enabled {
        return Err("Enable GitHub access before pushing.".into());
    }
    let policy = d
        .workspaces
        .iter()
        .find(|w| w["workspace"].as_str() == Some(workspace))
        .ok_or("This sandbox has no GitHub repository authorization.")?;
    validate(std::slice::from_ref(policy))?;
    if policy["repositoryMode"].as_str() != Some("all")
        && !policy["repositories"].as_array().is_some_and(|repos| {
            repos
                .iter()
                .any(|r| r["repository"].as_str() == Some(repository))
        })
    {
        return Err("This repository is not authorized for the sandbox.".into());
    }
    let c = active_credential()?;
    let catalog = catalog(&c)?;
    let repo = catalog
        .iter()
        .find(|r| r["name"].as_str() == Some(repository))
        .ok_or("GitHub no longer authorizes this repository.")?;
    let owner = repo["ownerId"]
        .as_u64()
        .ok_or("Invalid repository owner.")?;
    let id = repo["id"]
        .as_u64()
        .ok_or("Invalid repository identifier.")?;
    let response = token_operation(
        Operation::Scope,
        json!({"accessToken":c.access_token,"ownerId":owner,"repositoryIds":[id],"allowChanges":true}),
    )?;
    token_expiry(&response)?;
    response["accessToken"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "GitHub returned no restricted push credential.".into())
}

fn callback(request: &str, state: &str) -> Result<Option<String>, String> {
    let Some(line) = request.lines().next() else {
        return Ok(None);
    };
    let parts: Vec<_> = line.split_whitespace().collect();
    if parts.len() != 3
        || parts[0] != "GET"
        || !matches!(parts[2], "HTTP/1.0" | "HTTP/1.1")
        || !parts[1].starts_with('/')
        || parts[1].starts_with("//")
    {
        return Ok(None);
    }
    let Ok(url) = reqwest::Url::parse(&format!("http://127.0.0.1{}", parts[1])) else {
        return Ok(None);
    };
    if url.path() != "/github/callback" {
        return Ok(None);
    };
    let pairs: Vec<_> = url.query_pairs().collect();
    if pairs.iter().filter(|(k, _)| k == "state").count() != 1
        || !pairs.iter().any(|(k, v)| k == "state" && v == state)
    {
        return Ok(None);
    }
    if pairs.iter().any(|(k, _)| k == "error") {
        return Err("GitHub authorization was declined.".into());
    };
    if pairs.iter().filter(|(k, _)| k == "code").count() != 1 {
        return Err("Invalid GitHub authorization response.".into());
    };
    let code = pairs
        .iter()
        .find(|(k, _)| k == "code")
        .map(|(_, v)| v.as_ref())
        .unwrap_or_default();
    if code.is_empty() || code.len() > 1024 || !code.bytes().all(|b| b.is_ascii_graphic()) {
        return Err("Invalid GitHub authorization response.".into());
    }
    Ok(Some(code.into()))
}

// An unauthenticated local connection is not an OAuth result. Read a complete,
// bounded header before parsing it; ignore incomplete or malformed traffic.
fn read_callback_request(reader: &mut impl Read) -> Option<String> {
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut bytes = Vec::new();
    let mut chunk = [0; 1024];
    while bytes.len() < 8192 && Instant::now() < deadline {
        let remaining = (8192 - bytes.len()).min(chunk.len());
        let length = reader.read(&mut chunk[..remaining]).ok()?;
        if length == 0 {
            return None;
        }
        bytes.extend_from_slice(&chunk[..length]);
        if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            return String::from_utf8(bytes[..end + 4].to_vec()).ok();
        }
    }
    None
}
fn open_browser(url: &str) -> Result<(), String> {
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    if std::process::Command::new(opener)
        .arg(url)
        .status()
        .map_err(|_| "Cannot open the browser.")?
        .success()
    {
        Ok(())
    } else {
        Err("Cannot open the browser.".into())
    }
}
fn connect(app: &tauri::AppHandle) -> Result<Value, String> {
    let generation = CANCELLATION.load(Ordering::SeqCst);
    CONNECTING.store(true, Ordering::SeqCst);
    let _connecting = Connecting(app.clone());
    let _ = app.emit("silo://application-state-changed", ());
    let configuration = token_configuration()?;
    let client_id = &configuration.client_id;
    entry()?;
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|_| "Cannot start the GitHub callback listener.")?;
    listener
        .set_nonblocking(true)
        .map_err(|_| "Cannot configure GitHub callback listener.")?;
    let redirect = format!(
        "http://127.0.0.1:{}/github/callback",
        listener
            .local_addr()
            .map_err(|_| "Cannot read callback address.")?
            .port()
    );
    let state = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let verifier = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let mut url = reqwest::Url::parse("https://github.com/login/oauth/authorize").unwrap();
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", &redirect)
        .append_pair("state", &state)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256");
    open_browser(url.as_str())?;
    let deadline = Instant::now() + Duration::from_secs(300);
    let code = loop {
        if CANCELLATION.load(Ordering::SeqCst) != generation {
            return Err("GitHub connection cancelled.".into());
        }
        if Instant::now() > deadline {
            return Err("GitHub connection timed out. Try again.".into());
        };
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream.set_read_timeout(Some(Duration::from_secs(2))).ok();
                let result = read_callback_request(&mut stream)
                    .map(|request| callback(&request, &state))
                    .unwrap_or(Ok(None));
                let valid = matches!(&result, Ok(Some(_)));
                let text = if valid {
                    "GitHub authorization received. Return to Silo."
                } else {
                    "Invalid GitHub callback."
                };
                let _=write!(stream,"HTTP/1.1 {}\r\nContent-Type: text/plain\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",if valid{"200 OK"}else{"400 Bad Request"},text.len(),text);
                if let Some(code) = result? {
                    break code;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(50))
            }
            Err(_) => return Err("GitHub callback listener failed.".into()),
        }
    };
    let c = from_response(token_operation(
        Operation::Exchange,
        json!({"code":code,"codeVerifier":verifier,"redirectUri":redirect}),
    )?)?;
    let user = github(&c.access_token, "/user")?;
    let account = Some(
        user["login"]
            .as_str()
            .ok_or("GitHub account name is missing.")?
            .into(),
    );
    let (mut repos, installed) = catalog_installations(&c)?;
    if !installed {
        let slug = APP_SLUG.ok_or("GitHub App is not configured in this build.")?;
        if !slug.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
            return Err("GitHub App identifier is invalid.".into());
        }
        open_browser(&format!("https://github.com/apps/{slug}/installations/new"))?;
        let deadline = Instant::now() + Duration::from_secs(300);
        loop {
            if CANCELLATION.load(Ordering::SeqCst) != generation {
                return Err("GitHub connection cancelled.".into());
            }
            if Instant::now() >= deadline {
                return Err("GitHub repository authorization timed out. Connect again after authorizing the App.".into());
            }
            std::thread::sleep(Duration::from_secs(3));
            let result = catalog_installations(&c)?;
            if result.1 {
                repos = result.0;
                break;
            }
        }
    }
    if CANCELLATION.load(Ordering::SeqCst) != generation {
        return Err("GitHub connection cancelled.".into());
    }
    {
        let _state = STATE.lock().map_err(|_| "GitHub state is unavailable.")?;
        if CANCELLATION.load(Ordering::SeqCst) != generation {
            return Err("GitHub connection cancelled.".into());
        }
        let mut d = load(app)?;
        // Reconnecting creates a new account authorization. Never reuse old
        // grants, even if the account name and repository choices are identical.
        let prefix = format!("{}:", path(app)?.display());
        for w in &d.workspaces {
            if let Some(name) = w["workspace"].as_str() {
                crate::runtime::apply_github_policy(app, name, d.revision + 1, &profile(&[]))?;
            }
        }
        active()
            .lock()
            .map_err(|_| "GitHub state is unavailable.")?
            .retain(|key, _| !key.starts_with(&prefix));
        issued()
            .lock()
            .map_err(|_| "GitHub state is unavailable.")?
            .retain(|key, _| !key.starts_with(&prefix));
        store(&c)?;
        record_connection(&mut d, account, repos);
        save(app, &d)?;
    }
    schedule(Duration::from_millis(500));
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
    drop(_connecting);
    snapshot(app)
}

fn record_connection(d: &mut Document, account: Option<String>, repositories: Vec<Value>) {
    d.access_enabled = true;
    d.disconnect_pending = false;
    d.account = account;
    d.repositories = repositories;
    d.catalog_error = None;
    d.catalog_refresh_at = now() + 300;
    d.revision += 1;
    mark_pending(d);
}

fn catalog_refresh_due(d: &Document, now: u64) -> bool {
    d.access_enabled && d.account.is_some() && !d.disconnect_pending && now >= d.catalog_refresh_at
}

/// Re-establish host-only grants after relaunch and renew them before expiry.
pub fn install(app: &tauri::AppHandle) {
    let _ = OBSERVATION_APP.set(app.clone());
    if let Ok(document) = load(app) {
        crate::github_http::restore_retry_floor(document.rate_retry_at);
    }
    let app = app.clone();
    std::thread::spawn(move || loop {
        let pending_deadline = PENDING
            .get_or_init(|| Mutex::new(None))
            .lock()
            .ok()
            .and_then(|p| *p);
        let pending_due = pending_deadline.is_some_and(|time| Instant::now() >= time);
        if let Ok(_network) = OPERATION.try_lock() {
            let observed = {
                let _state = STATE.lock().ok();
                load(&app)
            };
            if let Ok(mut d) = observed {
                let due = worker_due(&d, pending_deadline, now(), Instant::now());
                if due {
                    if pending_due {
                        if let Ok(mut pending) = PENDING.get_or_init(|| Mutex::new(None)).lock() {
                            *pending = None;
                        }
                    }
                    // Refresh account/catalog independently. Never overwrite a newer desired document.
                    if !d.disconnect_pending
                        && d.account.is_some()
                        && credential()
                            .is_ok_and(|c| c.is_some_and(|c| c.expires_at <= now() + 120))
                    {
                        if let Err(message) = active_credential() {
                            if let Ok(_state) = STATE.lock() {
                                if let Ok(mut current) = load(&app) {
                                    current.catalog_error = Some(message);
                                    let _ = save(&app, &current);
                                }
                            }
                        }
                    }
                    if catalog_refresh_due(&d, now()) && credential().is_ok_and(|c| c.is_some()) {
                        let result = active_credential().and_then(|c| catalog(&c));
                        if let Ok(_state) = STATE.lock() {
                            if let Ok(mut current) = load(&app) {
                                match result {
                                    Ok(repos) => {
                                        if current.repositories != repos {
                                            current.access_pending = current
                                                .workspaces
                                                .iter()
                                                .filter_map(|w| {
                                                    w["workspace"].as_str().map(str::to_owned)
                                                })
                                                .collect();
                                        }
                                        current.repositories = repos;
                                        current.catalog_error = None;
                                        current.catalog_refresh_at = now() + 300;
                                    }
                                    Err(message) => {
                                        current.catalog_error = Some(message);
                                        current.catalog_refresh_at =
                                            crate::github_http::retry_at().max(now() + 30);
                                    }
                                }
                                // A catalog can remove authority too; narrow before doing network work.
                                if let Err(message) = narrow_now(&app, &mut current) {
                                    current.catalog_error = Some(message);
                                }
                                let _ = save(&app, &current);
                                d = current;
                            }
                        }
                    }
                    if d.disconnect_pending {
                        let result = revocation_credential().and_then(|c| {
                            c.map_or(Ok(()), |c| {
                                token_operation(
                                    Operation::RevokeAuthorization,
                                    json!({"accessToken":c.access_token}),
                                )
                                .map(|_| ())
                            })
                        });
                        if let Ok(_state) = STATE.lock() {
                            if let Ok(mut current) = load(&app) {
                                match result {
                                    Ok(()) => match delete_account_credential() {
                                        Ok(()) => {
                                            current.disconnect_pending = false;
                                            current.account = None;
                                            current.repositories.clear();
                                            current.catalog_error = None;
                                        }
                                        Err(error) => {
                                            current.catalog_error = Some(error);
                                        }
                                    },
                                    Err(message) => {
                                        current.catalog_error = Some(message);
                                    }
                                }
                                let _ = save(&app, &current);
                                d = current;
                            }
                        }
                    }
                    let _ = apply(&app, &mut d, None, false);
                    // Removed sandboxes still have a durable retirement ledger.
                    if let Ok(ledger) = ledger_entry().and_then(|entry| read_ledger(&entry)) {
                        for name in ledger.keys() {
                            if !d
                                .workspaces
                                .iter()
                                .any(|w| w["workspace"].as_str() == Some(name))
                            {
                                let _ = retire_unused(&app, name);
                            }
                        }
                    }
                    let account_credential = credential();
                    if let Ok(_state) = STATE.lock() {
                        if let Ok(mut current) = load(&app) {
                            current.session = session().into();
                            if current.workspaces.is_empty() {
                                current.refresh_at = now() + 3600;
                            }
                            let retry = crate::github_http::retry_at();
                            if retry > 0 {
                                current.refresh_at = current.refresh_at.min(retry.max(now() + 1));
                            }
                            if current.disconnect_pending {
                                current.refresh_at = current.refresh_at.min(if retry > 0 {
                                    retry.max(now() + 1)
                                } else {
                                    now() + 300
                                });
                            }
                            if let Ok(Some(c)) = account_credential {
                                current.refresh_at = current
                                    .refresh_at
                                    .min(c.expires_at.saturating_sub(120).max(now() + 30));
                            }
                            let _ = save(&app, &current);
                        }
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    });
}

fn require_main(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err("Only the main window can manage GitHub access.".into())
    }
}

async fn run(
    app: tauri::AppHandle,
    f: fn(&tauri::AppHandle) -> Result<Value, String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = OPERATION.lock().map_err(|_| "GitHub operation failed.")?;
        f(&app)
    })
    .await
    .map_err(|_| "GitHub operation failed.")?
}
#[tauri::command]
pub async fn read_github_state(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || snapshot(&app))
        .await
        .map_err(|_| "GitHub state could not be read.")?
}
#[tauri::command]
pub async fn connect_github(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Value, String> {
    require_main(window.label())?;
    run(app, connect).await
}
#[tauri::command]
pub async fn refresh_github_repositories(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Value, String> {
    require_main(window.label())?;
    crate::github_http::reset_retries();
    run(app, |app| {
        let result = active_credential().and_then(|c| catalog(&c));
        let _state = STATE.lock().map_err(|_| "GitHub state is unavailable.")?;
        let mut d = load(app)?;
        match result {
            Ok(repos) => {
                if d.repositories != repos {
                    mark_pending(&mut d);
                }
                d.repositories = repos;
                d.catalog_error = None;
                d.catalog_refresh_at = now() + 300;
            }
            Err(message) => {
                d.catalog_error = Some(message);
            }
        }
        if let Err(message) = narrow_now(app, &mut d) {
            d.catalog_error = Some(message);
        }
        save(app, &d)?;
        schedule(Duration::from_millis(500));
        snapshot(app)
    })
    .await
}
#[tauri::command]
pub async fn disconnect_github(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Value, String> {
    require_main(window.label())?;
    let ticket = INTENTS.ticket();
    CANCELLATION.fetch_add(1, Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || {
        let _turn = INTENTS.wait(ticket)?;
        let _state = STATE.lock().map_err(|_| "GitHub state is unavailable.")?;
        let mut d = load(&app)?;
        d.access_enabled = false;
        d.disconnect_pending = true;
        d.revision += 1;
        mark_pending(&mut d);
        save(&app, &d)?;
        let result = narrow_now(&app, &mut d);
        schedule(Duration::ZERO);
        result?;
        snapshot(&app)
    })
    .await
    .map_err(|_| "GitHub operation failed.")?
}
#[tauri::command]
pub async fn set_github_access_enabled(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    enabled: bool,
) -> Result<Value, String> {
    require_main(window.label())?;
    let ticket = INTENTS.ticket();
    if !enabled {
        CANCELLATION.fetch_add(1, Ordering::SeqCst);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _turn = INTENTS.wait(ticket)?;
        let _state = STATE.lock().map_err(|_| "GitHub state is unavailable.")?;
        let mut d = load(&app)?;
        if d.access_enabled == enabled {
            return snapshot(&app);
        }
        d.access_enabled = enabled;
        d.revision += 1;
        mark_pending(&mut d);
        save(&app, &d)?;
        let result = narrow_now(&app, &mut d);
        schedule(Duration::from_millis(500));
        result?;
        snapshot(&app)
    })
    .await
    .map_err(|_| "GitHub operation failed.")?
}
fn access_choice(policy: &Value) -> Value {
    let all = policy["repositoryMode"] == "all";
    let mut repos = policy["repositories"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    repos.sort_by(|a, b| a["repository"].as_str().cmp(&b["repository"].as_str()));
    if all {
        json!({"all":true,"changes":policy["allRepositoriesAllowChanges"]})
    } else {
        json!({"all":false,"repositories":repos})
    }
}
fn mark_pending_for(d: &mut Document, names: &[String]) {
    for name in names {
        d.operations
            .retain(|op| op["workspace"].as_str() != Some(name));
        d.operations.push(
            json!({"workspace":name,"status":"applying","message":"Applying GitHub settings."}),
        );
    }
}
fn mark_pending(d: &mut Document) {
    d.access_pending = d
        .workspaces
        .iter()
        .filter_map(|w| w["workspace"].as_str().map(str::to_owned))
        .collect();
    mark_pending_for(d, &d.access_pending.clone());
}
#[tauri::command]
pub async fn save_github_configuration(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    configuration: Value,
) -> Result<Value, String> {
    require_main(window.label())?;
    let ws = configuration["workspaces"]
        .as_array()
        .ok_or("Missing sandbox policies.")?;
    validate(ws)?;
    configuration["accessEnabled"]
        .as_bool()
        .ok_or("Missing GitHub access choice.")?;
    let ticket = INTENTS.ticket();
    tauri::async_runtime::spawn_blocking(move || {
        let ws = configuration["workspaces"]
            .as_array()
            .ok_or("Missing sandbox policies.")?;
        validate(ws)?;
        let enabled = configuration["accessEnabled"]
            .as_bool()
            .ok_or("Missing GitHub access choice.")?;
        let _turn = INTENTS.wait(ticket)?;
        let _state = STATE.lock().map_err(|_| "GitHub state is unavailable.")?;
        let mut d = load(&app)?;
        if d.workspaces == *ws && d.access_enabled == enabled {
            return snapshot(&app);
        }
        CANCELLATION.fetch_add(1, Ordering::SeqCst);
        let mut access_changed = d.access_pending.clone();
        for w in ws {
            let previous = d
                .workspaces
                .iter()
                .find(|old| old["workspace"] == w["workspace"]);
            if d.access_enabled != enabled
                || previous.is_none_or(|old| access_choice(old) != access_choice(w))
            {
                if let Some(name) = w["workspace"].as_str() {
                    if !access_changed.iter().any(|n| n == name) {
                        access_changed.push(name.into());
                    }
                }
            }
            if previous.is_none_or(|old| old["identity"] != w["identity"]) {
                let name = w["workspace"].as_str().ok_or("Invalid sandbox policy.")?;
                if !d.identity_pending.iter().any(|n| n == name) {
                    d.identity_pending.push(name.into());
                }
            }
        }
        d.workspaces = ws.clone();
        d.access_enabled = enabled;
        d.revision += 1;
        let mut changed = access_changed.clone();
        changed.extend(d.identity_pending.iter().cloned());
        changed.sort();
        changed.dedup();
        mark_pending_for(&mut d, &changed);
        d.access_pending = access_changed;
        // Persist first so a worker completing concurrently cannot publish old choices.
        save(&app, &d)?;
        let result = narrow_now(&app, &mut d);
        schedule(Duration::from_millis(500));
        if let Err(message) = result {
            for op in d.operations.iter_mut().filter(|op| {
                op["workspace"]
                    .as_str()
                    .is_some_and(|name| changed.iter().any(|changed| changed == name))
            }) {
                op["status"] = json!("failed");
                op["message"] = json!(&message);
                op["canRetry"] = json!(true);
            }
            save(&app, &d)?;
        }
        snapshot(&app)
    })
    .await
    .map_err(|_| "GitHub operation failed.")?
}
#[tauri::command]
pub async fn retry_github_configuration(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    workspace: Option<String>,
) -> Result<Value, String> {
    require_main(window.label())?;
    let ticket = INTENTS.ticket();
    crate::github_http::reset_retries();
    tauri::async_runtime::spawn_blocking(move || {
        let _turn = INTENTS.wait(ticket)?;
        let _state = STATE.lock().map_err(|_| "GitHub state is unavailable.")?;
        let mut d = load(&app)?;
        for w in &d.workspaces {
            if let Some(name) = w["workspace"].as_str() {
                if workspace.as_deref().is_none_or(|target| target == name)
                    && d.identity_errors.contains_key(name)
                    && !d.identity_pending.iter().any(|n| n == name)
                {
                    d.identity_pending.push(name.into());
                }
            }
        }
        mark_pending(&mut d);
        if let Some(target) = &workspace {
            d.access_pending.retain(|name| name == target);
        }
        save(&app, &d)?;
        schedule(Duration::ZERO);
        snapshot(&app)
    })
    .await
    .map_err(|_| "GitHub operation failed.")?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn test_scope() -> GrantScope {
        GrantScope {
            owner: 1,
            login: "owner".into(),
            ids: vec![1, 2, 3],
            writes: vec![2],
            all: false,
        }
    }
    fn test_grant() -> RuntimeGrant {
        RuntimeGrant {
            owner_id: 1,
            owner_login: "owner".into(),
            repository_ids: vec![1, 2, 3],
            read_token: "read".into(),
            write_token: Some("write".into()),
            write_repository_ids: vec![2],
            expires_at: now() + 1000,
            read_expires_at: now() + 1000,
            write_expires_at: now() + 1000,
            all_repositories: false,
        }
    }
    #[test]
    fn rapid_edits_delay_network_until_latest_half_second_deadline() {
        let d = Document {
            session: session().into(),
            refresh_at: 0,
            ..Default::default()
        };
        let first = Instant::now();
        let latest = first + Duration::from_millis(400);
        assert!(!worker_due(
            &d,
            Some(latest + Duration::from_millis(500)),
            100,
            first + Duration::from_millis(500)
        ));
        assert!(worker_due(
            &d,
            Some(latest + Duration::from_millis(500)),
            100,
            first + Duration::from_millis(900)
        ));
    }
    #[test]
    fn identity_only_edit_does_not_request_access_or_postpone_renewal() {
        let d = Document {
            session: session().into(),
            refresh_at: 160,
            identity_pending: vec!["dev".into()],
            ..Default::default()
        };
        assert!(!access_update_due(&d, "dev", 100));
        assert!(access_update_due(&d, "dev", 160));
        assert_eq!(d.refresh_at, 160);
    }
    #[test]
    fn repository_catalog_has_independent_refresh_deadline() {
        let d = Document {
            session: session().into(),
            access_enabled: true,
            account: Some("owner".into()),
            refresh_at: 3600,
            catalog_refresh_at: 300,
            workspaces: vec![json!({"repositoryMode":"all"})],
            ..Default::default()
        };
        assert!(!worker_due(&d, None, 299, Instant::now()));
        assert!(worker_due(&d, None, 300, Instant::now()));
    }
    #[test]
    fn local_edits_preserve_submission_order_without_holding_network_lock() {
        let queue = std::sync::Arc::new(IntentQueue::new());
        let first = queue.ticket();
        let second = queue.ticket();
        let first_turn = queue.wait(first).unwrap();
        let (sent, received) = std::sync::mpsc::channel();
        let other = queue.clone();
        let worker = std::thread::spawn(move || {
            let _turn = other.wait(second).unwrap();
            sent.send("second applied").unwrap();
        });
        assert!(received.try_recv().is_err());
        drop(first_turn);
        assert_eq!(
            received.recv_timeout(Duration::from_secs(1)).unwrap(),
            "second applied"
        );
        worker.join().unwrap();
    }
    #[test]
    fn invalid_remaining_selection_never_preserves_removed_repository_access() {
        let previous = test_grant();
        let document = Document {
            access_enabled: true,
            account: Some("owner".into()),
            repositories: vec![],
            ..Default::default()
        };
        let policy = json!({"repositoryMode":"selected","repositories":[{"repository":"owner/no-longer-authorized","allowPushes":false}]});
        let desired = scopes(&document, &policy);
        assert!(desired.is_err());
        let (retained, error) = narrow_checked(&[previous], desired);
        assert!(retained.is_empty());
        assert!(error.is_some());
    }

    #[test]
    fn unchanged_scopes_do_not_issue_or_refresh_credentials() {
        let grants = reconcile_grants(
            &[test_scope()],
            &[test_grant()],
            |_, _| panic!("unchanged scope made a network call"),
            || true,
        )
        .unwrap();
        assert_eq!(grants[0].read_token, "read");
        assert_eq!(grants[0].write_token.as_deref(), Some("write"));
    }
    #[test]
    fn adding_read_repository_only_replaces_read_group() {
        let mut scope = test_scope();
        scope.ids.push(4);
        let mut calls = Vec::new();
        let grants = reconcile_grants(
            &[scope],
            &[test_grant()],
            |s, write| {
                calls.push((s.owner, write));
                Ok(("new-read".into(), now() + 1000))
            },
            || true,
        )
        .unwrap();
        assert_eq!(calls, vec![(1, false)]);
        assert_eq!(grants[0].write_token.as_deref(), Some("write"));
    }
    #[test]
    fn removing_read_repository_detaches_old_read_but_reuses_safe_write() {
        let mut scope = test_scope();
        scope.ids = vec![1, 2];
        let old = test_grant();
        let retained = narrow(&[old], &[scope.clone()]);
        assert!(profile(&retained)["owners"].as_array().unwrap().is_empty());
        assert_eq!(retained[0].write_token.as_deref(), Some("write"));
        let mut calls = vec![];
        let grants = reconcile_grants(
            &[scope],
            &retained,
            |_, write| {
                calls.push(write);
                Ok(("narrow-read".into(), now() + 1000))
            },
            || true,
        )
        .unwrap();
        assert_eq!(calls, vec![false]);
        assert_eq!(grants[0].write_token.as_deref(), Some("write"));
    }
    #[test]
    fn disabling_writes_detaches_write_without_reminting_read() {
        let mut scope = test_scope();
        scope.writes.clear();
        let retained = narrow(&[test_grant()], &[scope.clone()]);
        assert_eq!(retained[0].write_token, None);
        let grants = reconcile_grants(
            &[scope],
            &retained,
            |_, _| panic!("write removal minted a token"),
            || true,
        )
        .unwrap();
        assert_eq!(grants[0].read_token, "read");
        assert_eq!(grants[0].write_token, None);
    }
    #[test]
    fn obsolete_read_result_never_causes_write_issuance() {
        let current = std::cell::Cell::new(true);
        let mut calls = 0;
        let result = reconcile_grants(
            &[test_scope()],
            &[],
            |_, write| {
                assert!(!write);
                calls += 1;
                current.set(false);
                Ok(("read".into(), now() + 1000))
            },
            || current.get(),
        );
        assert!(result.is_err());
        assert_eq!(calls, 1);
    }
    #[test]
    fn all_to_selected_never_reuses_all_repository_tokens() {
        let mut old = test_grant();
        old.all_repositories = true;
        let retained = narrow(&[old], &[test_scope()]);
        assert!(retained[0].read_token.is_empty());
        assert!(retained[0].write_token.is_none());
        let mut calls = vec![];
        reconcile_grants(
            &[test_scope()],
            &retained,
            |_, write| {
                calls.push(write);
                Ok(("new".into(), now() + 1000))
            },
            || true,
        )
        .unwrap();
        assert_eq!(calls, vec![false, true]);
    }
    #[test]
    fn unrelated_owner_and_vm_status_stays_unchanged() {
        let mut d = Document {
            operations: vec![
                json!({"workspace":"dev","status":"succeeded"}),
                json!({"workspace":"other","status":"succeeded"}),
            ],
            ..Default::default()
        };
        mark_pending_for(&mut d, &["dev".into()]);
        assert_eq!(
            d.operations
                .iter()
                .find(|op| op["workspace"] == "other")
                .unwrap()["status"],
            "succeeded"
        );
    }
    #[test]
    fn identity_and_inactive_selection_changes_do_not_change_access_choice() {
        let mut first = json!({"repositoryMode":"all","allRepositoriesAllowChanges":false,"repositories":[],"identity":{"name":"Old"}});
        let choice = access_choice(&first);
        first["identity"] = json!({"name":"New"});
        first["repositories"] = json!([{"repository":"owner/other","allowPushes":true}]);
        assert_eq!(access_choice(&first), choice);
    }
    #[test]
    fn partially_issued_read_is_reusable_only_for_its_exact_scope() {
        let token = IssuedToken {
            owner: 1,
            all: false,
            write: false,
            ids: vec![1, 2, 3],
            token: "temporary".into(),
            expires_at: now() + 1000,
        };
        assert!(issued_matches(&token, &test_scope(), false));
        assert!(!issued_matches(&token, &test_scope(), true));
        let mut other = test_scope();
        other.ids.push(4);
        assert!(!issued_matches(&token, &other, false));
    }
    #[test]
    fn background_grant_refresh_never_writes_git_identity() {
        let (result, _) = finish_application(Ok(()), false, None, || {
            panic!("background renewal must not run guest identity commands")
        });
        assert!(result.is_ok());
        let (result, _) =
            finish_application(Ok(()), false, Some("previous identity error"), || {
                panic!("background renewal must not retry identity")
            });
        assert_eq!(result, Err("previous identity error".into()));
    }
    #[test]
    fn explicit_identity_application_is_independent_of_github_access() {
        let mut applied = false;
        let (result, identity_result) =
            finish_application(Err("GitHub is unavailable".into()), true, None, || {
                applied = true;
                Ok(())
            });
        assert_eq!(result, Err("GitHub is unavailable".into()));
        assert!(identity_result.is_ok());
        assert!(applied);
    }
    #[test]
    fn optional_github_keeps_verified_setup_when_secure_store_is_unavailable() {
        let d = Document {
            session: session().into(),
            operations: vec![json!({"workspace":"dev","status":"succeeded"})],
            ..Default::default()
        };
        let state = public_snapshot(
            d,
            Err("The system credential store is unavailable.".into()),
            None,
        );
        assert_eq!(state["state"], "disconnected");
        assert_eq!(state["repositoryCatalogStatus"]["status"], "unavailable");
        assert_eq!(state["workspaceOperations"][0]["status"], "succeeded");
    }
    #[test]
    fn runtime_token_ledger_survives_reload_only_in_secure_store() {
        let entry =
            keyring::Entry::new_with_credential(Box::new(keyring::mock::MockCredential::default()));
        assert!(read_ledger(&entry).unwrap().is_empty());
        let mut ledger = TokenLedger::new();
        ledger.insert("dev".into(), vec!["test-scoped-token".into()]);
        save_ledger(&entry, &ledger).unwrap();
        assert_eq!(read_ledger(&entry).unwrap(), ledger);
        let mock = entry
            .get_credential()
            .downcast_ref::<keyring::mock::MockCredential>()
            .unwrap();
        mock.set_error(keyring::Error::Invalid(
            "locked".into(),
            "private detail".into(),
        ));
        assert!(read_ledger(&entry).is_err());
        assert_eq!(read_ledger(&entry).unwrap(), ledger);
    }
    #[test]
    fn connection_enables_access_without_selecting_repositories() {
        let mut document = Document::default();
        record_connection(&mut document, Some("account".into()), vec![]);
        assert!(document.access_enabled);
        assert!(document.workspaces.is_empty());
        assert!(document.access_pending.is_empty());

        document.access_enabled = false;
        document.disconnect_pending = true;
        document.workspaces = vec![json!({"workspace":"dev"})];
        record_connection(&mut document, Some("account".into()), vec![]);
        assert!(document.access_enabled);
        assert!(!document.disconnect_pending);
        assert_eq!(document.access_pending, vec!["dev"]);
        assert_eq!(document.operations[0]["status"], "applying");
    }

    #[test]
    fn connected_catalog_refreshes_before_token_expiry_for_every_selection_mode() {
        let mut d = Document {
            session: session().into(),
            access_enabled: true,
            account: Some("owner".into()),
            workspaces: vec![json!({"repositoryMode":"all"})],
            catalog_refresh_at: 100,
            refresh_at: 3600,
            ..Default::default()
        };
        assert!(!catalog_refresh_due(&d, 99));
        assert!(catalog_refresh_due(&d, 100));
        d.workspaces[0]["repositoryMode"] = json!("selected");
        assert!(worker_due(&d, None, 100, Instant::now()));
        d.workspaces.clear();
        assert!(worker_due(&d, None, 100, Instant::now()));
        d.access_enabled = false;
        assert!(!catalog_refresh_due(&d, 100));
        d.access_enabled = true;
        d.account = None;
        assert!(!catalog_refresh_due(&d, 100));
        d.account = Some("owner".into());
        d.disconnect_pending = true;
        assert!(!catalog_refresh_due(&d, 100));
    }
    #[test]
    fn secure_store_failure_does_not_become_disconnected_or_save_plaintext() {
        let entry =
            keyring::Entry::new_with_credential(Box::new(keyring::mock::MockCredential::default()));
        let mock = entry
            .get_credential()
            .downcast_ref::<keyring::mock::MockCredential>()
            .unwrap();
        mock.set_error(keyring::Error::Invalid(
            "unavailable".into(),
            "sensitive diagnostic".into(),
        ));
        let error = read_entry(&entry).err().unwrap();
        assert!(!error.contains("sensitive diagnostic"));
        assert!(read_entry(&entry).unwrap().is_none());
        mock.set_error(keyring::Error::Invalid(
            "unavailable".into(),
            "sensitive diagnostic".into(),
        ));
        assert!(store_entry(
            &entry,
            &Credential {
                access_token: "test-only".into(),
                refresh_token: None,
                expires_at: now() + 300
            }
        )
        .is_err());
        assert!(matches!(entry.get_password(), Err(keyring::Error::NoEntry)));
    }
    #[test]
    fn durable_document_contains_no_credentials() {
        let d = Document::default();
        let encoded = serde_json::to_string(&d).unwrap();
        assert!(!encoded.contains("accessToken"));
        assert!(!encoded.contains("refreshToken"));
    }
    #[test]
    fn rejects_missing_or_expired_lifetimes() {
        assert!(from_response(json!({"accessToken":"test-only"})).is_err());
        assert!(token_expiry(&json!({"expiresAt":"2020-01-01T00:00:00Z"})).is_err());
        assert!(token_expiry(&json!({"expiresAt":"not-a-date"})).is_err());
    }
    #[test]
    fn refresh_storage_retry_never_reuses_a_consumed_refresh_token() {
        let old = Credential {
            access_token: "old".into(),
            refresh_token: Some("old-refresh".into()),
            expires_at: 100,
        };
        let mut pending = None;
        let result = refresh_credential_with(
            old.clone(),
            &mut pending,
            100,
            |_| {
                Ok(Credential {
                    access_token: "new".into(),
                    refresh_token: Some("new-refresh".into()),
                    expires_at: 1000,
                })
            },
            |_| Err("secure store locked".into()),
        );
        assert!(result.is_err());
        let restored = refresh_credential_with(
            old,
            &mut pending,
            101,
            |_| panic!("a consumed refresh token was replayed"),
            |credential| {
                assert_eq!(credential.access_token, "new");
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(restored.refresh_token.as_deref(), Some("new-refresh"));
        assert!(pending.is_none());
    }
    #[test]
    fn new_login_does_not_restore_another_accounts_pending_refresh() {
        let mut pending = Some(PendingRefresh {
            previous_access: "old-account".into(),
            renewed: Credential {
                access_token: "old-renewed".into(),
                refresh_token: None,
                expires_at: 1000,
            },
        });
        let new = Credential {
            access_token: "new-account".into(),
            refresh_token: None,
            expires_at: 1000,
        };
        let result = refresh_credential_with(
            new,
            &mut pending,
            100,
            |_| panic!("unneeded refresh"),
            |_| panic!("stale credential persisted"),
        )
        .unwrap();
        assert_eq!(result.access_token, "new-account");
        assert!(pending.is_none());
    }
    #[test]
    fn only_main_window_can_manage_github() {
        assert!(require_main("main").is_ok());
        for label in ["status", "other", ""] {
            assert!(require_main(label).is_err());
        }
    }
    #[test]
    fn callback_ignores_unrelated_traffic_and_rejects_empty_authenticated_code() {
        for request in [
            "",
            "garbage",
            "GET //evil/github/callback?state=right&code=x HTTP/1.1",
            "GET /github/callback?state=wrong&error=denied HTTP/1.1",
        ] {
            assert_eq!(callback(request, "right").unwrap(), None);
        }
        for request in [
            "GET /github/callback?state=right&code= HTTP/1.1",
            "GET /github/callback?state=right&code=%20 HTTP/1.1",
            "GET /github/callback?state=right&error=denied HTTP/1.1",
        ] {
            assert!(callback(request, "right").is_err());
        }
    }
    #[test]
    fn callback_requires_complete_bounded_headers_across_fragments() {
        struct Fragmented<'a>(&'a [u8]);
        impl Read for Fragmented<'_> {
            fn read(&mut self, target: &mut [u8]) -> std::io::Result<usize> {
                let length = target.len().min(3).min(self.0.len());
                target[..length].copy_from_slice(&self.0[..length]);
                self.0 = &self.0[length..];
                Ok(length)
            }
        }
        let request =
            b"GET /github/callback?state=right&code=x HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";
        let complete = read_callback_request(&mut Fragmented(request)).unwrap();
        assert_eq!(callback(&complete, "right").unwrap(), Some("x".into()));
        assert!(read_callback_request(&mut Fragmented(&request[..request.len() - 2])).is_none());
        assert!(read_callback_request(&mut Fragmented(&vec![b'a'; 9000])).is_none());
    }
    #[test]
    fn callback_rejects_wrong_state_and_duplicate_code() {
        assert!(callback(
            "GET /github/callback?state=wrong&code=x HTTP/1.1\r\n",
            "right"
        )
        .unwrap()
        .is_none());
        assert!(callback(
            "GET /github/callback?state=right&code=x&code=y HTTP/1.1\r\n",
            "right"
        )
        .is_err());
        assert_eq!(
            callback(
                "GET /github/callback?state=right&code=x HTTP/1.1\r\n",
                "right"
            )
            .unwrap(),
            Some("x".into())
        );
    }
    #[test]
    fn reject_ambiguous_policy() {
        assert!(validate(&[json!({"workspace":"a","repositoryMode":"all","allRepositoriesAllowChanges":false,"repositories":[],"identity":{"name":"","email":"","apply":false}})]).is_ok());
        assert!(validate(&[json!({"workspace":"a","repositoryMode":"anything","allRepositoriesAllowChanges":false,"repositories":[]})]).is_err());
    }
    #[test]
    fn rejects_unknown_nested_policy_data_and_invalid_identity() {
        let good = json!({"workspace":"dev","repositoryMode":"selected","allRepositoriesAllowChanges":false,
            "repositories":[{"repository":"owner/repo","allowPushes":false}],
            "identity":{"name":"Name","email":"name@example.invalid","apply":true}});
        assert!(validate(&[good.clone()]).is_ok());
        let mut injected = good.clone();
        injected["identity"]["accessToken"] = json!("must-not-persist");
        assert!(validate(&[injected]).is_err());
        let mut injected = good.clone();
        injected["repositories"][0]["credential"] = json!("must-not-persist");
        assert!(validate(&[injected]).is_err());
        let mut invalid = good;
        invalid["identity"]["name"] = json!("name\ncommand");
        assert!(validate(&[invalid]).is_err());
    }

    #[test]
    fn blocked_credential_read_never_blocks_public_snapshot() {
        for previous in [None, Some(Ok(Some(now() + 600)))] {
            let observation = std::sync::Arc::new(Mutex::new(previous.clone()));
            let observed = observation.clone();
            let (started, reading) = std::sync::mpsc::channel();
            let (release, released) = std::sync::mpsc::channel();
            let (published, update) = std::sync::mpsc::channel();
            let reader = std::thread::spawn(move || {
                observe_credential_read(
                    || {
                        started.send(()).unwrap();
                        released.recv().unwrap();
                        Err(
                            "Cannot read GitHub credentials from the system credential store."
                                .into(),
                        )
                    },
                    |value| {
                        *observed.lock().unwrap() = Some(value);
                        published.send(()).unwrap();
                    },
                )
            });
            reading.recv_timeout(Duration::from_secs(1)).unwrap();
            // A pending OS permission prompt cannot hold the snapshot state lock.
            let state = observation.try_lock().unwrap().clone();
            let snapshot = observed_snapshot(Document::default(), state, None);
            assert_eq!(
                snapshot["state"],
                if previous.is_some() {
                    "connected"
                } else {
                    "disconnected"
                }
            );
            if previous.is_none() {
                assert_eq!(snapshot["repositoryCatalogStatus"]["status"], "unavailable");
                assert_eq!(snapshot["repositoryCatalogStatus"]["canRetry"], false);
            }
            assert!(update.try_recv().is_err());
            release.send(()).unwrap();
            update.recv_timeout(Duration::from_secs(1)).unwrap();
            assert!(reader.join().unwrap().is_err());
            let snapshot = observed_snapshot(
                Document::default(),
                observation.lock().unwrap().clone(),
                None,
            );
            assert_eq!(snapshot["state"], "disconnected");
            assert_eq!(snapshot["repositoryCatalogStatus"]["status"], "unavailable");
            assert_eq!(snapshot["repositoryCatalogStatus"]["canRetry"], true);
        }
    }
    #[test]
    fn credential_observation_exposes_only_lifetime_and_absence() {
        let expiry = now() + 600;
        let mut observed = None;
        let result = observe_credential_read(
            || {
                Ok(Some(Credential {
                    access_token: "private-access".into(),
                    refresh_token: Some("private-refresh".into()),
                    expires_at: expiry,
                }))
            },
            |value| observed = Some(value),
        );
        assert!(result.unwrap().is_some());
        assert_eq!(observed, Some(Ok(Some(expiry))));
        observe_credential_read(|| Ok(None), |value| observed = Some(value)).unwrap();
        assert_eq!(observed, Some(Ok(None)));
    }
    #[test]
    fn missing_token_response_is_error() {
        assert!(from_response(json!({})).is_err());
    }
    #[test]
    fn public_github_state_matches_frontend_contract() {
        let states: Vec<Value> =
            serde_json::from_str(include_str!("../../src/test/contracts/github-state.json"))
                .unwrap();
        for expected in states {
            let d = Document {
                revision: 7,
                access_enabled: true,
                account: Some("test-account".into()),
                session: session().into(),
                workspaces: expected["workspaces"].as_array().unwrap().clone(),
                repositories: vec![json!({"id":1,"ownerId":2,"name":"test-owner/repo"})],
                operations: expected["workspaceOperations"].as_array().unwrap().clone(),
                ..Default::default()
            };
            let stored = if expected["state"] == "connected" {
                Some(now() + 600)
            } else {
                None
            };
            let actual = public_snapshot(d, Ok(stored), None);
            assert_eq!(actual, expected);
            assert!(!actual.to_string().contains("contract-token-not-real"));
        }
    }
}
