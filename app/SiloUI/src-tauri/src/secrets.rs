//! Host-only secret values. The durable document contains references and public status only.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::Read,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

static PATH: OnceLock<PathBuf> = OnceLock::new();
static OPERATION: Mutex<()> = Mutex::new(());
static DOCUMENT: Mutex<()> = Mutex::new(());
type Vault = BTreeMap<String, String>;
static VAULT: Mutex<Option<Result<Vault, String>>> = Mutex::new(None);
const STORE_ERROR: &str =
    "Cannot access secrets in the system credential store. Unlock it and retry.";
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Secret {
    id: String,
    name: String,
    value_id: String,
    workspaces: Vec<String>,
    allowed_domains: Vec<String>,
    #[serde(default)]
    affected: Vec<String>,
    #[serde(default)]
    pending_workspaces: Vec<String>,
    #[serde(default)]
    errors: BTreeMap<String, String>,
    #[serde(default)]
    removing: bool,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Document {
    #[serde(default)]
    secrets: Vec<Secret>,
    #[serde(default)]
    activities: Vec<Value>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    operation: String,
    id: Option<String>,
    name: String,
    value: Option<String>,
    workspaces: Vec<String>,
    allowed_domains: Vec<String>,
}
fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("org.silo.Silo.secrets", "values").map_err(|_| STORE_ERROR.into())
}
fn read_vault() -> Result<Vault, String> {
    let mut cached = VAULT.lock().map_err(|_| STORE_ERROR)?;
    cached
        .get_or_insert_with(|| match entry()?.get_password() {
            Ok(value) => serde_json::from_str(&value).map_err(|_| STORE_ERROR.into()),
            Err(keyring::Error::NoEntry) => Ok(Vault::new()),
            Err(_) => Err(STORE_ERROR.into()),
        })
        .clone()
}
fn write_vault(value: Vault) -> Result<(), String> {
    let mut cached = VAULT.lock().map_err(|_| STORE_ERROR)?;
    if let Some(Err(error)) = cached.as_ref() {
        return Err(error.clone());
    }
    if matches!(cached.as_ref(), Some(Ok(old)) if old == &value) {
        return Ok(());
    }
    let encoded = serde_json::to_string(&value).map_err(|_| STORE_ERROR)?;
    let result = entry()?
        .set_password(&encoded)
        .map_err(|_| STORE_ERROR.to_string());
    *cached = Some(result.clone().map(|_| value));
    result
}
fn retry_store() {
    if let Ok(mut cached) = VAULT.lock() {
        if matches!(cached.as_ref(), Some(Err(_))) {
            *cached = None;
        }
    }
}
fn load() -> Result<Document, String> {
    let Some(path) = PATH.get() else {
        return Ok(Document::default());
    };
    match File::open(path) {
        Ok(file) => serde_json::from_reader(file.take(2 * 1024 * 1024))
            .map_err(|_| "Secret settings could not be read. No settings were overwritten.".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Document::default()),
        Err(_) => Err("Secret settings could not be read.".into()),
    }
}
fn save(document: &Document) -> Result<(), String> {
    let path = PATH.get().ok_or("Secret storage is not initialized.")?;
    let parent = path.parent().ok_or("Secret storage is unavailable.")?;
    fs::create_dir_all(parent).map_err(|_| "Secret settings could not be saved.")?;
    let mut file = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| "Secret settings could not be saved.")?;
    serde_json::to_writer(&mut file, document)
        .map_err(|_| "Secret settings could not be saved.")?;
    file.as_file()
        .sync_all()
        .map_err(|_| "Secret settings could not be saved.")?;
    file.persist(path)
        .map_err(|_| "Secret settings could not be saved.")?;
    Ok(())
}
fn update(f: impl FnOnce(&mut Document) -> Result<(), String>) -> Result<(), String> {
    let _guard = DOCUMENT.lock().map_err(|_| "Secret settings are busy.")?;
    let mut document = load()?;
    f(&mut document)?;
    save(&document)
}
fn prune_values() -> Result<(), String> {
    let referenced: BTreeSet<_> = load()?.secrets.into_iter().map(|s| s.value_id).collect();
    let mut values = read_vault()?;
    values.retain(|id, _| referenced.contains(id));
    write_vault(values)
}
fn public(secret: &Secret) -> Value {
    let errors = secret
        .errors
        .iter()
        .map(|(name, error)| format!("{name}: {error}"))
        .collect::<Vec<_>>();
    json!({"id":secret.id,"name":secret.name,"workspaces":secret.workspaces,"allowedDomains":secret.allowed_domains,
        "state": if secret.errors.is_empty() && secret.affected.iter().any(|workspace| !secret.pending_workspaces.contains(workspace)) {
            "applying"
        } else if secret.pending_workspaces.is_empty() {"active"} else {"restart-required"},
        "pendingWorkspaces":secret.pending_workspaces,"removing":secret.removing,
        "error": if errors.is_empty() {Value::Null} else {json!(errors.join(" "))}})
}
pub(crate) fn snapshot() -> Result<Vec<Value>, String> {
    Ok(load()?.secrets.iter().map(public).collect())
}
pub(crate) fn activities() -> Result<Vec<Value>, String> {
    Ok(load()?.activities)
}
pub(crate) fn runtime_material(
    workspace: &str,
) -> Result<Vec<(String, String, Vec<String>)>, String> {
    let document = load()?;
    let selected: Vec<_> = document
        .secrets
        .iter()
        .filter(|s| !s.removing && s.workspaces.iter().any(|w| w == workspace))
        .collect();
    if selected.is_empty() {
        return Ok(Vec::new());
    }
    let values = read_vault()?;
    selected
        .into_iter()
        .map(|s| {
            Ok((
                s.name.clone(),
                values.get(&s.value_id).ok_or(STORE_ERROR)?.clone(),
                s.allowed_domains.clone(),
            ))
        })
        .collect()
}
fn event(document: &mut Document, title: &str, failed: bool) {
    let now = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();
    document.activities.push(json!({"id":uuid::Uuid::new_v4().to_string(),"category":"secrets","title":title,"detail":"Secret values are kept in the system credential store.","occurredAt":now,"time":now,"tone":if failed {"danger"} else {"success"},"status":"completed"}));
    if document.activities.len() > 100 {
        document.activities.remove(0);
    }
}
fn revision(document: &Document, workspace: &str) -> String {
    let desired: Vec<_> = document
        .secrets
        .iter()
        .filter(|s| !s.removing && s.workspaces.iter().any(|w| w == workspace))
        .map(|s| (&s.name, &s.value_id, &s.allowed_domains))
        .collect();
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&desired).unwrap_or_default())
    )
}
pub(crate) fn workspace_revision(workspace: &str) -> Result<String, String> {
    Ok(revision(&load()?, workspace))
}
pub(crate) fn workspace_started(workspace: &str, applied_revision: &str) -> Result<(), String> {
    // Called only after runtime verification. No operation lock: start owns the runtime lock.
    if PATH.get().is_none() {
        return Ok(());
    }
    update(|document| {
        if revision(document, workspace) != applied_revision {
            return Ok(());
        }
        for secret in &mut document.secrets {
            secret.pending_workspaces.retain(|w| w != workspace);
            secret.affected.retain(|w| w != workspace);
            secret.errors.remove(workspace);
        }
        Ok(())
    })
}
pub(crate) fn workspace_removed(workspace: &str) -> Result<(), String> {
    if PATH.get().is_none() {
        return Ok(());
    }
    update(|document| {
        for secret in &mut document.secrets {
            secret.workspaces.retain(|w| w != workspace);
            secret.affected.retain(|w| w != workspace);
            secret.pending_workspaces.retain(|w| w != workspace);
            secret.errors.remove(workspace);
        }
        Ok(())
    })
}
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .enumerate()
            .all(|(i, c)| c == b'_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit()))
        && ![
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "PATH",
            "HOME",
            "SHELL",
            "USER",
            "LOGNAME",
            "TMPDIR",
            "TMP",
            "TEMP",
            "BASH_ENV",
            "ENV",
            "SHELLOPTS",
            "BASHOPTS",
            "IFS",
            "CDPATH",
            "GLOBIGNORE",
            "HOSTNAME",
            "HOSTALIASES",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
            "CURL_CA_BUNDLE",
            "GIT_SSL_CAINFO",
            "GIT_CONFIG_NOSYSTEM",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "NO_PROXY",
        ]
        .contains(&name.to_ascii_uppercase().as_str())
        && !["DYLD_", "LD_", "SILO_", "MSB_", "RUST_"]
            .iter()
            .any(|prefix| name.to_ascii_uppercase().starts_with(prefix))
}
fn valid_domain(domain: &str) -> bool {
    if domain == "*" {
        return true;
    }
    let host = domain.strip_prefix("*.").unwrap_or(domain);
    host.len() <= 253
        && (!domain.starts_with("*.") || host.contains('.'))
        && host.split('.').all(|part| {
            !part.is_empty()
                && part.len() <= 63
                && !part.starts_with('-')
                && !part.ends_with('-')
                && part
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        })
}
fn validate(request: &Request, document: &Document) -> Result<(), String> {
    if !valid_name(&request.name) {
        return Err("Choose a valid, unreserved secret name.".into());
    }
    if !matches!(request.operation.as_str(), "add" | "edit") {
        return Err("Unknown secret operation.".into());
    }
    let original = request
        .id
        .as_ref()
        .and_then(|id| document.secrets.iter().find(|s| &s.id == id));
    if request.operation == "edit" && original.is_none() {
        return Err("This secret no longer exists.".into());
    }
    if original.is_some_and(|s| s.name != request.name || s.removing) {
        return Err("Secret names cannot change. Finish removal before adding it again.".into());
    }
    if document
        .secrets
        .iter()
        .any(|s| s.name == request.name && Some(&s.id) != request.id.as_ref())
    {
        return Err("A secret with this name already exists.".into());
    }
    if request.operation == "add"
        && (request.id.is_some() || request.value.as_deref().is_none_or(str::is_empty))
    {
        return Err("Enter a secret value.".into());
    }
    if request
        .value
        .as_ref()
        .is_some_and(|v| v.is_empty() || v.len() > 64 * 1024 || v.contains('\0'))
    {
        return Err(
            "Secret values must contain between 1 and 65536 bytes without null characters.".into(),
        );
    }
    if request.workspaces.is_empty()
        || request.workspaces.len() > 100
        || request.workspaces.iter().collect::<BTreeSet<_>>().len() != request.workspaces.len()
        || request.allowed_domains.is_empty()
        || request.allowed_domains.len() > 100
        || !request.allowed_domains.iter().all(|d| valid_domain(d))
    {
        return Err("Select sandboxes and valid allowed domains.".into());
    }
    Ok(())
}
fn reconcile(app: &AppHandle, id: &str) -> Result<(), String> {
    update(|d| {
        let secret = d
            .secrets
            .iter_mut()
            .find(|s| s.id == id)
            .ok_or("This secret no longer exists.")?;
        secret.errors.remove("Credential store");
        Ok(())
    })?;
    let document = load()?;
    let secret = document
        .secrets
        .iter()
        .find(|s| s.id == id)
        .ok_or("This secret no longer exists.")?;
    let targets: BTreeSet<_> = secret
        .affected
        .iter()
        .chain(secret.workspaces.iter())
        .cloned()
        .collect();
    for workspace in targets {
        let result = runtime_material(&workspace)
            .and_then(|desired| crate::runtime::apply_secrets(app, &workspace, desired));
        update(|document| {
            let secret = document
                .secrets
                .iter_mut()
                .find(|s| s.id == id)
                .ok_or("This secret no longer exists.")?;
            secret.pending_workspaces.retain(|w| w != &workspace);
            match &result {
                Ok(pending_names) => {
                    secret.errors.remove(&workspace);
                    if !secret.removing && pending_names.contains(&secret.name) {
                        secret.pending_workspaces.push(workspace.clone());
                    } else {
                        secret.affected.retain(|w| w != &workspace);
                    }
                }
                Err(error) => {
                    secret.errors.insert(workspace.clone(), error.clone());
                }
            }
            Ok(())
        })?;
        let _ = app.emit("silo://application-state-changed", ());
    }
    let document = load()?;
    let secret = document
        .secrets
        .iter()
        .find(|s| s.id == id)
        .ok_or("This secret no longer exists.")?;
    let failed = !secret.errors.is_empty();
    if secret.removing && !failed && secret.pending_workspaces.is_empty() {
        // Keep the tombstone until both revocation and credential deletion succeed.
        let mut values = read_vault()?;
        values.remove(&secret.value_id);
        if let Err(error) = write_vault(values) {
            update(|d| {
                d.secrets
                    .iter_mut()
                    .find(|s| s.id == id)
                    .unwrap()
                    .errors
                    .insert("Credential store".into(), error);
                Ok(())
            })?;
            return Ok(());
        }
        update(|d| {
            d.secrets.retain(|s| s.id != id);
            event(d, "Secret removed", false);
            Ok(())
        })?;
    } else {
        update(|d| {
            event(
                d,
                if failed {
                    "Secret changes could not be applied"
                } else {
                    "Secret settings saved"
                },
                failed,
            );
            Ok(())
        })?;
    }
    Ok(())
}
fn require_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Secret changes are only available in the main window.".into())
    }
}
#[tauri::command]
pub async fn read_secrets_state() -> Result<Vec<Value>, String> {
    snapshot()
}
#[tauri::command]
pub async fn save_secret(
    app: AppHandle,
    window: WebviewWindow,
    request: Request,
) -> Result<Vec<Value>, String> {
    require_main(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _update = crate::updates::operation_guard()?;
        let _operation = OPERATION.lock().map_err(|_| "Secret settings are busy.")?;
        retry_store();
        let document = load()?;
        validate(&request, &document)?;
        crate::runtime::validate_secret_workspaces(&app, &request.workspaces)?;
        let id = request
            .id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let original = document.secrets.iter().find(|s| s.id == id);
        let value_id = if let Some(value) = &request.value {
            let value_id = uuid::Uuid::new_v4().to_string();
            let mut values = read_vault()?;
            values.insert(value_id.clone(), value.clone());
            write_vault(values)?;
            value_id
        } else {
            original.ok_or("Enter a secret value.")?.value_id.clone()
        };
        update(|d| {
            let affected = original
                .into_iter()
                .flat_map(|s| s.affected.iter().chain(s.workspaces.iter()))
                .chain(request.workspaces.iter())
                .cloned()
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
            d.secrets.retain(|s| s.id != id);
            d.secrets.push(Secret {
                id: id.clone(),
                name: request.name,
                value_id,
                workspaces: request.workspaces,
                allowed_domains: request.allowed_domains,
                affected,
                pending_workspaces: Vec::new(),
                errors: BTreeMap::new(),
                removing: false,
            });
            Ok(())
        })?;
        let _ = app.emit("silo://application-state-changed", ());
        reconcile(&app, &id)?;
        let _ = prune_values();
        snapshot()
    })
    .await
    .map_err(|_| "Secret changes could not finish.".to_string())?
}
#[tauri::command]
pub async fn remove_secret(
    app: AppHandle,
    window: WebviewWindow,
    id: String,
) -> Result<Vec<Value>, String> {
    require_main(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _update = crate::updates::operation_guard()?;
        let _operation = OPERATION.lock().map_err(|_| "Secret settings are busy.")?;
        retry_store();
        update(|d| {
            let secret = d
                .secrets
                .iter_mut()
                .find(|s| s.id == id)
                .ok_or("This secret no longer exists.")?;
            secret.removing = true;
            secret.affected.extend(secret.workspaces.clone());
            Ok(())
        })?;
        reconcile(&app, &id)?;
        let _ = prune_values();
        snapshot()
    })
    .await
    .map_err(|_| "Secret removal could not finish.".to_string())?
}
#[tauri::command]
pub async fn retry_secret(
    app: AppHandle,
    window: WebviewWindow,
    id: String,
) -> Result<Vec<Value>, String> {
    require_main(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _update = crate::updates::operation_guard()?;
        let _operation = OPERATION.lock().map_err(|_| "Secret settings are busy.")?;
        retry_store();
        reconcile(&app, &id)?;
        let _ = prune_values();
        snapshot()
    })
    .await
    .map_err(|_| "Secret changes could not finish.".to_string())?
}
pub(crate) fn install(app: &AppHandle) -> Result<(), String> {
    PATH.set(
        app.path()
            .app_data_dir()
            .map_err(|_| "Secret storage is unavailable.")?
            .join("secrets.json"),
    )
    .ok();
    let app = app.clone();
    std::thread::spawn(move || {
        let Ok(_operation) = OPERATION.lock() else {
            return;
        };
        if let Ok(document) = load() {
            for secret in document.secrets {
                if !secret.affected.is_empty() || secret.removing {
                    let _ = reconcile(&app, &secret.id);
                }
            }
        }
        let _ = app.emit("silo://application-state-changed", ());
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> Request {
        Request {
            operation: "add".into(),
            id: None,
            name: "API_KEY".into(),
            value: Some("private-value".into()),
            workspaces: vec!["dev".into()],
            allowed_domains: vec!["api.example.com".into()],
        }
    }
    fn secret() -> Secret {
        Secret {
            id: "id".into(),
            name: "API_KEY".into(),
            value_id: "private-reference".into(),
            workspaces: vec!["dev".into()],
            allowed_domains: vec!["api.example.com".into()],
            affected: vec!["dev".into()],
            pending_workspaces: Vec::new(),
            errors: BTreeMap::new(),
            removing: false,
        }
    }
    #[test]
    fn applied_revision_changes_for_rotation_domains_and_removal_not_status() {
        let mut d = Document {
            secrets: vec![secret()],
            ..Default::default()
        };
        let original = revision(&d, "dev");
        d.secrets[0].errors.insert("dev".into(), "Retry".into());
        d.secrets[0].pending_workspaces.push("dev".into());
        assert_eq!(revision(&d, "dev"), original);
        d.secrets[0].value_id = "new-value-reference".into();
        assert_ne!(revision(&d, "dev"), original);
        let rotated = revision(&d, "dev");
        d.secrets[0].allowed_domains = vec!["other.example.com".into()];
        assert_ne!(revision(&d, "dev"), rotated);
        d.secrets[0].removing = true;
        assert_eq!(revision(&d, "dev"), revision(&Document::default(), "dev"));
    }
    #[test]
    fn backend_rejects_reserved_names_before_storage() {
        for name in [
            "PATH",
            "HOME",
            "GH_TOKEN",
            "SILO_GITHUB",
            "MSB_HOME",
            "LD_PRELOAD",
            "DYLD_INSERT_LIBRARIES",
            "http_proxy",
            "1KEY",
            "A=B",
            "msb_path",
        ] {
            let mut r = request();
            r.name = name.into();
            assert!(validate(&r, &Document::default()).is_err(), "{name}");
        }
        assert!(validate(&request(), &Document::default()).is_ok());
    }
    #[test]
    fn values_and_domain_constraints_are_validated_on_host() {
        for value in [String::new(), "bad\0value".into(), "a".repeat(65537)] {
            let mut r = request();
            r.value = Some(value);
            assert!(validate(&r, &Document::default()).is_err());
        }
        for domain in [
            "https://api.example.com",
            "api.example.com/path",
            "user@host.test",
            "*.com",
            "api.example.com:443",
            "-bad.test",
            "",
        ] {
            assert!(!valid_domain(domain), "{domain}");
        }
        for domain in ["api.example.com", "*.example.com", "*"] {
            assert!(valid_domain(domain));
        }
    }
    #[test]
    fn edits_preserve_name_and_do_not_require_value() {
        let mut r = request();
        r.operation = "edit".into();
        r.id = Some("id".into());
        r.value = None;
        let d = Document {
            secrets: vec![secret()],
            ..Default::default()
        };
        assert!(validate(&r, &d).is_ok());
        r.name = "NEW_KEY".into();
        assert!(validate(&r, &d).is_err());
        assert!(validate(&request(), &d).is_err());
    }
    #[test]
    fn snapshots_expose_only_public_metadata_and_actual_pending_vms() {
        let mut s = secret();
        s.pending_workspaces = vec!["dev".into()];
        let value = public(&s);
        let text = value.to_string();
        assert!(!text.contains("private-reference"));
        assert!(value.get("value").is_none());
        assert_eq!(value["state"], "restart-required");
        assert_eq!(value["pendingWorkspaces"], json!(["dev"]));
        s.pending_workspaces.clear();
        s.errors
            .insert("dev".into(), "Could not apply secret changes.".into());
        assert!(public(&s)["error"].as_str().unwrap().contains("dev:"));
        s.removing = true;
        assert_eq!(public(&s)["removing"], true);
    }
    #[test]
    fn persisted_unfinished_secret_targets_are_not_reported_active_after_relaunch() {
        let mut secret = secret();
        assert_eq!(public(&secret)["state"], "applying");
        secret.pending_workspaces.push("dev".into());
        assert_eq!(public(&secret)["state"], "restart-required");
        secret.affected.push("other".into());
        assert_eq!(public(&secret)["state"], "applying");
        secret.errors.insert("other".into(), "Could not apply changes.".into());
        assert_eq!(public(&secret)["state"], "restart-required");
        assert!(public(&secret)["error"].is_string());
        secret.affected.clear();
        secret.pending_workspaces.clear();
        secret.errors.clear();
        assert_eq!(public(&secret)["state"], "active");
    }
    #[test]
    fn history_is_bounded_and_contains_no_values() {
        let mut d = Document::default();
        for _ in 0..110 {
            event(&mut d, "Secret settings saved", false);
        }
        assert_eq!(d.activities.len(), 100);
        assert!(d
            .activities
            .iter()
            .all(|e| e["category"] == "secrets" && e["status"] == "completed"));
        assert!(!serde_json::to_string(&d).unwrap().contains("private-value"));
    }
}

pub(crate) fn update_guard() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    OPERATION.try_lock().map_err(|_| "Wait for the secret operation to finish before updating.".into())
}
