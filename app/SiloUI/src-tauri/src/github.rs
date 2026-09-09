//! Host-only GitHub account and durable desired policy. No credential is exposed by a command.
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
        Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

static OPERATION: Mutex<()> = Mutex::new(());
static SESSION: OnceLock<String> = OnceLock::new();
static PENDING_RETIREMENTS: OnceLock<Mutex<std::collections::HashMap<String, Vec<String>>>> =
    OnceLock::new();
fn session() -> &'static str {
    SESSION.get_or_init(|| uuid::Uuid::new_v4().to_string())
}
static CONNECTING: AtomicBool = AtomicBool::new(false);
static CANCELLATION: AtomicU64 = AtomicU64::new(0);
struct Connecting;
impl Drop for Connecting {
    fn drop(&mut self) {
        CONNECTING.store(false, Ordering::SeqCst);
    }
}
const SERVICE: Option<&str> = option_env!("SILO_GITHUB_SERVICE_URL");
const CLIENT_ID: Option<&str> = option_env!("SILO_GITHUB_CLIENT_ID");
const APP_SLUG: Option<&str> = option_env!("SILO_GITHUB_APP_SLUG");

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Credential {
    access_token: String,
    refresh_token: Option<String>,
    expires_at: u64,
}
#[derive(Default, Serialize, Deserialize)]
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
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("org.silo.Silo.github", "account")
        .map_err(|_| "The system credential store is unavailable.".into())
}
fn credential() -> Result<Option<Credential>, String> {
    read_entry(&entry()?)
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
    store_entry(&entry()?, c)
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
        .map_err(|_| "Cannot sync GitHub configuration directory.".into())
}
fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Silo")
        .build()
        .map_err(|_| "Cannot initialize GitHub connection.".into())
}
fn service(route: &str, body: Value) -> Result<Value, String> {
    let root = SERVICE.ok_or("GitHub connection is not configured in this build.")?;
    let url = reqwest::Url::parse(root).map_err(|_| "GitHub service URL is invalid.")?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("GitHub service requires a configured HTTPS URL.".into());
    };
    let r = client()?
        .post(format!("{}{}", root.trim_end_matches('/'), route))
        .json(&body)
        .send()
        .map_err(|_| "Cannot reach the GitHub authentication service.")?;
    if !r.status().is_success() {
        return Err(format!(
            "GitHub authentication service refused the request ({}).",
            r.status().as_u16()
        ));
    };
    r.json()
        .map_err(|_| "GitHub authentication service returned an invalid response.".into())
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
fn active_credential() -> Result<Credential, String> {
    let c = credential()?.ok_or("Connect GitHub first.")?;
    if c.expires_at > now() + 120 {
        return Ok(c);
    };
    let refresh = c
        .refresh_token
        .ok_or("GitHub access expired. Reconnect GitHub.")?;
    let renewed = from_response(service(
        "/v1/oauth/refresh",
        json!({"refreshToken":refresh}),
    )?)?;
    store(&renewed)?;
    Ok(renewed)
}
fn github(token: &str, path: &str) -> Result<Value, String> {
    let r = client()?
        .get(format!("https://api.github.com{path}"))
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .map_err(|_| "Cannot reach GitHub.")?;
    if !r.status().is_success() {
        return Err(format!(
            "GitHub refused the request ({}).",
            r.status().as_u16()
        ));
    };
    r.json()
        .map_err(|_| "GitHub returned an invalid response.".into())
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
    Ok(public_snapshot(
        load(app)?,
        credential(),
        crate::host_identity::read(),
    ))
}
fn public_snapshot(
    mut d: Document,
    stored: Result<Option<Credential>, String>,
    identity: Option<crate::host_identity::HostIdentity>,
) -> Value {
    let connected = match stored {
        Ok(credential) => credential.is_some_and(|c| c.expires_at > now()),
        Err(message) => {
            d.catalog_error = Some(message);
            false
        }
    };
    if d.session != session() {
        d.operations = d.workspaces.iter().map(|w|json!({"workspace":w["workspace"],"status":"failed","message":"GitHub access must be verified for this app session.","canRetry":true})).collect();
    }

    json!({"state":if CONNECTING.load(Ordering::SeqCst){"connecting"}else if connected{"connected"}else{"disconnected"},"account":d.account,"accessEnabled":d.access_enabled,"hostIdentity":identity,"repositoryCatalog":d.repositories.iter().filter_map(|r|r["name"].as_str()).collect::<Vec<_>>(),"repositoryCatalogStatus":match &d.catalog_error { Some(message)=>json!({"status":"unavailable","message":message,"canRetry":true}),None=>json!({"status":"available"})},"workspaces":d.workspaces,"workspaceOperations":d.operations})
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
fn remember_grants(
    app: &tauri::AppHandle,
    workspace: &str,
    grants: &[RuntimeGrant],
) -> Result<(), String> {
    if grants.is_empty() {
        return Ok(());
    }
    let entry = ledger_entry()?;
    let mut ledger = read_ledger(&entry)?;
    let tokens = ledger.entry(workspace.into()).or_default();
    for grant in grants {
        tokens.push(grant.read_token.clone());
        if let Some(write) = &grant.write_token {
            tokens.push(write.clone());
        }
    }
    tokens.sort();
    tokens.dedup();
    save_ledger(&entry, &ledger)?;
    let mut document = load(app)?;
    document.grants_issued = true;
    save(app, &document)
}

fn retire_previous(app: &tauri::AppHandle, workspace: &str, revision: u64) -> Result<(), String> {
    let pending = PENDING_RETIREMENTS.get_or_init(|| Mutex::new(std::collections::HashMap::new()));
    let mut tokens = crate::runtime::scoped_cached_tokens(app, workspace)?;
    if tokens.is_empty()
        && !load(app)?.grants_issued
        && pending
            .lock()
            .map_err(|_| "GitHub revocation state is unavailable.")?
            .get(workspace)
            .is_none()
    {
        // GitHub is optional. A sandbox that has never received credentials does not need a keyring to stay disabled.
        return crate::runtime::apply_github_policy(
            app,
            workspace,
            revision,
            &json!({"version":1,"owners":[]}),
        );
    }
    let ledger_entry = ledger_entry();
    let mut ledger = ledger_entry
        .as_ref()
        .map_err(Clone::clone)
        .and_then(read_ledger);
    if let Ok(stored) = &ledger {
        if let Some(previous) = stored.get(workspace) {
            tokens.extend(previous.iter().cloned());
        }
    }

    if let Some(previous) = pending
        .lock()
        .map_err(|_| "GitHub revocation state is unavailable.")?
        .get(workspace)
    {
        tokens.extend(previous.iter().cloned());
    }
    tokens.sort();
    tokens.dedup();
    let deadline = Instant::now() + Duration::from_secs(45);
    let mut first_failure = ledger.as_ref().err().cloned();
    let mut network_failed = false;
    let mut remaining = Vec::new();
    for token in tokens {
        if !network_failed && Instant::now() < deadline {
            if service("/v1/tokens/revoke", json!({"accessToken":&token})).is_ok() {
                continue;
            }
        }
        network_failed = true;
        first_failure=Some("GitHub could not confirm that previous access was revoked. Access remains pending; retry when connected.".to_string());
        remaining.push(token);
    }
    if let (Ok(entry), Ok(stored)) = (&ledger_entry, &mut ledger) {
        let previous = stored.clone();
        if remaining.is_empty() {
            stored.remove(workspace);
        } else {
            stored.insert(workspace.into(), remaining.clone());
        }
        if previous != *stored {
            if let Err(message) = save_ledger(entry, stored) {
                first_failure = Some(message);
            }
        }
    }
    let mut state = pending
        .lock()
        .map_err(|_| "GitHub revocation state is unavailable.")?;
    if remaining.is_empty() {
        state.remove(workspace);
    } else {
        state.insert(workspace.into(), remaining);
    }
    drop(state);
    // Always disable locally too, even when GitHub is offline. Never lose the failed-token retry list.
    let local = crate::runtime::apply_github_policy(
        app,
        workspace,
        revision,
        &json!({"version":1,"owners":[]}),
    );
    match (first_failure, local) {
        (None, Ok(())) => Ok(()),
        (Some(message), _) => Err(message),
        (None, Err(message)) => Err(message),
    }
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

fn apply(
    app: &tauri::AppHandle,
    d: &mut Document,
    workspace: Option<&str>,
    apply_identity: bool,
) -> Result<(), String> {
    let generation = CANCELLATION.load(Ordering::SeqCst);
    let mut refresh_at = if workspace.is_some() {
        d.refresh_at.min(now() + 3600)
    } else {
        now() + 3600
    };
    for w in &d.workspaces {
        let name = w["workspace"].as_str().ok_or("Invalid sandbox policy.")?;
        if workspace.is_some_and(|target| target != name) {
            continue;
        }
        // Revoke old authority before fetching replacements. A network/store failure must not keep old writes active.
        let result = retire_previous(app,name,d.revision)
        .and_then(|_| { if CANCELLATION.load(Ordering::SeqCst)!=generation {Err("GitHub access changed during this operation. Applying the latest choice.".into())} else {runtime_grants(app,name)} }).and_then(|grants| {
            if CANCELLATION.load(Ordering::SeqCst)!=generation {return Err("GitHub access changed during this operation. Applying the latest choice.".into());}
            if let Some(expiry)=grants.iter().map(|g|g.expires_at).min() { refresh_at=refresh_at.min(expiry.saturating_sub(120)); }
            remember_grants(app,name,&grants)?;
            let profiles=json!({"version":1,"owners":grants.into_iter().map(|g|json!({"login":g.owner_login,"repositoryIds":g.repository_ids,"readToken":g.read_token,"writeToken":g.write_token,"expiresAt":g.expires_at})).collect::<Vec<_>>()});
            crate::runtime::apply_github_policy(app,name,d.revision,&profiles)
        });
        if result.is_err() {
            refresh_at = refresh_at.min(now() + 60);
        }
        let (result, identity_result) = finish_application(
            result,
            apply_identity,
            d.identity_errors.get(name).map(String::as_str),
            || crate::runtime::apply_github_identity(app, name, &w["identity"]),
        );
        if apply_identity {
            match &identity_result {
                Ok(()) => {
                    d.identity_errors.remove(name);
                }
                Err(message) => {
                    d.identity_errors.insert(name.into(), message.clone());
                }
            }
        }
        let operation = match result {
            Ok(()) => {
                json!({"workspace": name,"status":"succeeded","message":"GitHub access verified."})
            }
            Err(message) => {
                json!({"workspace":name,"status":"failed","message":message,"canRetry":true})
            }
        };
        d.operations
            .retain(|op| op["workspace"].as_str() != Some(name));
        d.operations.push(operation);
    }
    // Grant issuance refreshes the authorized catalog. Retain that observation
    // instead of overwriting it with this operation's earlier policy snapshot.
    let latest = load(app)?;
    d.repositories = latest.repositories;
    d.catalog_error = latest.catalog_error;
    d.catalog_refresh_at = latest.catalog_refresh_at;
    d.grants_issued = latest.grants_issued;
    d.session = session().into();
    d.refresh_at = refresh_at;
    save(app, d)
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
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeGrant {
    pub owner_id: u64,
    pub owner_login: String,
    pub repository_ids: Vec<u64>,
    pub read_token: String,
    pub write_token: Option<String>,
    pub write_repository_ids: Vec<u64>,
    pub expires_at: u64,
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
pub(crate) fn runtime_grants(
    app: &tauri::AppHandle,
    workspace: &str,
) -> Result<Vec<RuntimeGrant>, String> {
    let mut d = load(app)?;
    if !d.access_enabled || credential()?.is_none() {
        return Ok(Vec::new());
    }
    let policy = d
        .workspaces
        .iter()
        .find(|w| w["workspace"].as_str() == Some(workspace))
        .cloned()
        .ok_or("No GitHub policy exists for this sandbox.")?;
    validate(std::slice::from_ref(&policy))?;
    let c = active_credential()?;
    d.repositories = catalog(&c)?;
    d.catalog_error = None;
    d.catalog_refresh_at = now() + 300;
    save(app, &d)?;
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
    let mut groups = std::collections::BTreeMap::<u64, (String, Vec<u64>, Vec<u64>)>::new();
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
            .and_then(|n| n.split('/').next())
            .ok_or("Invalid GitHub repository name.")?;
        let group = groups
            .entry(owner)
            .or_insert_with(|| (login.to_string(), vec![], vec![]));
        group.1.push(id);
        if if all {
            policy["allRepositoriesAllowChanges"].as_bool() == Some(true)
        } else {
            selection.is_some_and(|s| s["allowPushes"].as_bool() == Some(true))
        } {
            group.2.push(id)
        }
    }
    let mut grants = Vec::new();
    for (owner, (login, read_ids, write_ids)) in groups {
        let read = service(
            "/v1/tokens/scope",
            json!({"accessToken":c.access_token,"ownerId":owner,"repositoryIds":if all {vec![]} else {read_ids.clone()},"allRepositories":all,"allowChanges":false}),
        )?;
        let read_token = read["accessToken"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("GitHub returned no restricted read credential.")?
            .to_string();
        let mut expiry = token_expiry(&read)?;
        let write_token = if write_ids.is_empty() {
            None
        } else {
            let response = service(
                "/v1/tokens/scope",
                json!({"accessToken":c.access_token,"ownerId":owner,"repositoryIds":if all {vec![]} else {write_ids.clone()},"allRepositories":all,"allowChanges":true}),
            )?;
            expiry = expiry.min(token_expiry(&response)?);
            Some(
                response["accessToken"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or("GitHub returned no restricted write credential.")?
                    .to_string(),
            )
        };
        grants.push(RuntimeGrant {
            owner_id: owner,
            owner_login: login,
            repository_ids: read_ids,
            read_token,
            write_token,
            write_repository_ids: write_ids,
            expires_at: expiry,
        });
    }
    Ok(grants)
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
    let response = service(
        "/v1/tokens/scope",
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
    let line = request.lines().next().ok_or("Invalid OAuth callback.")?;
    let parts: Vec<_> = line.split_whitespace().collect();
    if parts.len() != 3 || parts[0] != "GET" {
        return Ok(None);
    }
    let url = reqwest::Url::parse(&format!("http://127.0.0.1{}", parts[1]))
        .map_err(|_| "Invalid OAuth callback.")?;
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
    Ok(pairs
        .iter()
        .find(|(k, _)| k == "code")
        .map(|(_, v)| v.to_string()))
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
    let _connecting = Connecting;
    let client_id = CLIENT_ID.ok_or("GitHub connection is not configured in this build.")?;
    SERVICE.ok_or("GitHub connection is not configured in this build.")?;
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
                let mut bytes = [0; 8192];
                let n = stream.read(&mut bytes).unwrap_or(0);
                let result = callback(&String::from_utf8_lossy(&bytes[..n]), &state);
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
    let c = from_response(service(
        "/v1/oauth/exchange",
        json!({"code":code,"codeVerifier":verifier,"redirectUri":redirect}),
    )?)?;
    let user = github(&c.access_token, "/user")?;
    let mut d = load(app)?;
    d.account = Some(
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
    d.repositories = repos;
    d.catalog_error = None;
    d.catalog_refresh_at = now() + 300;
    if CANCELLATION.load(Ordering::SeqCst) != generation {
        return Err("GitHub connection cancelled.".into());
    }
    store(&c)?;
    d.revision += 1;
    save(app, &d)?;
    apply(app, &mut d, None, false)?;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
    drop(_connecting);
    snapshot(app)
}

fn catalog_refresh_due(d: &Document, now: u64) -> bool {
    d.access_enabled
        && now >= d.catalog_refresh_at
        && d.workspaces
            .iter()
            .any(|w| w["repositoryMode"].as_str() == Some("all"))
}

/// Re-establish host-only grants after relaunch and renew them before expiry.
pub fn install(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        if let Ok(_guard) = OPERATION.try_lock() {
            if let Ok(mut d) = load(&app) {
                // Account renewal also works before the user creates their first sandbox.
                if d.account.is_some()
                    && credential().is_ok_and(|c| c.is_some_and(|c| c.expires_at <= now() + 120))
                {
                    if let Err(message) = active_credential() {
                        d.catalog_error = Some(message);
                        let _ = save(&app, &d);
                    }
                }
                // All repositories includes newly authorized owners as well as new repos.
                // Refresh the catalog independently of token expiry; unchanged catalogs do not interrupt connections.
                if catalog_refresh_due(&d, now()) && credential().is_ok_and(|c| c.is_some()) {
                    match active_credential().and_then(|c| catalog(&c)) {
                        Ok(repositories) => {
                            if d.repositories != repositories {
                                d.refresh_at = 0;
                            }
                            d.repositories = repositories;
                            d.catalog_error = None;
                            d.catalog_refresh_at = now() + 300;
                        }
                        Err(message) => {
                            d.catalog_error = Some(message);
                            d.catalog_refresh_at = now() + 60;
                        }
                    }
                    let _ = save(&app, &d);
                }
                if !d.workspaces.is_empty() && (d.session != session() || now() >= d.refresh_at) {
                    let _ = apply(&app, &mut d, None, false);
                }
            }
        }
        std::thread::sleep(Duration::from_secs(30));
    });
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
pub async fn connect_github(app: tauri::AppHandle) -> Result<Value, String> {
    run(app, connect).await
}
#[tauri::command]
pub async fn refresh_github_repositories(app: tauri::AppHandle) -> Result<Value, String> {
    run(app, |app| {
        let c = active_credential()?;
        let mut d = load(app)?;
        match catalog(&c) {
            Ok(repos) => {
                d.repositories = repos;
                d.catalog_error = None;
            }
            Err(message) => {
                d.catalog_error = Some(message);
                save(app, &d)?;
                return snapshot(app);
            }
        }
        save(app, &d)?;
        apply(app, &mut d, None, false)?;
        snapshot(app)
    })
    .await
}
#[tauri::command]
pub async fn disconnect_github(app: tauri::AppHandle) -> Result<Value, String> {
    CANCELLATION.fetch_add(1, Ordering::SeqCst);
    run(app, |app| {
        let mut d = load(app)?;
        d.access_enabled = false;
        d.revision += 1;
        save(app, &d)?;
        apply(app, &mut d, None, false)?;
        if let Some(c) = credential()? {
            service("/v1/oauth/revoke", json!({"accessToken":c.access_token}))?;
            entry()?
                .delete_credential()
                .map_err(|_| "Cannot remove GitHub credentials from the system credential store.")?
        };
        d.account = None;
        d.repositories.clear();
        save(app, &d)?;
        snapshot(app)
    })
    .await
}
#[tauri::command]
pub async fn set_github_access_enabled(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<Value, String> {
    if !enabled {
        CANCELLATION.fetch_add(1, Ordering::SeqCst);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = OPERATION.lock().map_err(|_| "GitHub operation failed.")?;
        let mut d = load(&app)?;
        d.access_enabled = enabled;
        d.revision += 1;
        save(&app, &d)?;
        apply(&app, &mut d, None, false)?;
        snapshot(&app)
    })
    .await
    .map_err(|_| "GitHub operation failed.")?
}
#[tauri::command]
pub async fn save_github_configuration(
    app: tauri::AppHandle,
    configuration: Value,
) -> Result<Value, String> {
    CANCELLATION.fetch_add(1, Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = OPERATION.lock().map_err(|_| "GitHub operation failed.")?;
        let ws = configuration["workspaces"]
            .as_array()
            .ok_or("Missing sandbox policies.")?;
        validate(ws)?;
        let mut d = load(&app)?;
        for previous in &d.workspaces {
            let name = previous["workspace"]
                .as_str()
                .ok_or("Invalid saved sandbox policy.")?;
            if !ws.iter().any(|w| w["workspace"].as_str() == Some(name)) {
                retire_previous(&app, name, d.revision + 1)?;
            }
        }
        d.workspaces = ws.clone();
        d.access_enabled = configuration["accessEnabled"]
            .as_bool()
            .ok_or("Missing GitHub access choice.")?;
        d.revision += 1;
        save(&app, &d)?;
        apply(&app, &mut d, None, true)?;
        snapshot(&app)
    })
    .await
    .map_err(|_| "GitHub operation failed.")?
}
#[tauri::command]
pub async fn retry_github_configuration(
    app: tauri::AppHandle,
    workspace: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = OPERATION.lock().map_err(|_| "GitHub operation failed.")?;
        let mut d = load(&app)?;
        apply(&app, &mut d, workspace.as_deref(), true)?;
        snapshot(&app)
    })
    .await
    .map_err(|_| "GitHub operation failed.")?
}

#[cfg(test)]
mod tests {
    use super::*;
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
    fn all_repositories_refreshes_new_owners_before_token_expiry() {
        let mut d = Document {
            access_enabled: true,
            workspaces: vec![json!({"repositoryMode":"all"})],
            catalog_refresh_at: 100,
            refresh_at: 3600,
            ..Default::default()
        };
        assert!(!catalog_refresh_due(&d, 99));
        assert!(catalog_refresh_due(&d, 100));
        d.workspaces[0]["repositoryMode"] = json!("selected");
        assert!(!catalog_refresh_due(&d, 100));
        d.workspaces[0]["repositoryMode"] = json!("all");
        d.access_enabled = false;
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
    fn missing_token_response_is_error() {
        assert!(from_response(json!({})).is_err());
    }
}
