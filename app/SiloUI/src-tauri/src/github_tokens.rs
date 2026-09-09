//! Direct native GitHub App operations. User credentials stay outside the WebView.
use crate::github_http::{self, Authentication, Request};
use reqwest::Method;
use serde_json::{json, Map, Value};

pub(crate) struct Configuration {
    pub client_id: String,
    pub client_secret: String,
}
#[derive(Clone, Copy)]
pub(crate) enum Operation {
    Exchange,
    Refresh,
    Scope,
    RevokeToken,
    RevokeAuthorization,
}
const INVALID: &str = "Invalid GitHub authorization request.";
const REPOSITORY_PERMISSIONS: &[&str] = &[
    "actions",
    "administration",
    "artifact_metadata",
    "attestations",
    "checks",
    "code_quality",
    "codespaces",
    "codespaces_lifecycle_admin",
    "codespaces_metadata",
    "codespaces_secrets",
    "contents",
    "dependabot_secrets",
    "deployments",
    "discussions",
    "environments",
    "issues",
    "merge_queues",
    "metadata",
    "packages",
    "pages",
    "pull_requests",
    "repository_custom_properties",
    "repository_hooks",
    "repository_projects",
    "repository_advisories",
    "secret_scanning_alerts",
    "secrets",
    "security_events",
    "single_file",
    "statuses",
    "vulnerability_alerts",
    "workflows",
    "actions_variables",
];
fn text(value: &Value) -> Result<&str, String> {
    value
        .as_str()
        .filter(|v| !v.is_empty() && v.len() <= 1024 && !v.bytes().any(|b| b <= 32 || b == 127))
        .ok_or_else(|| INVALID.into())
}
fn id(value: &Value) -> Result<u64, String> {
    value
        .as_u64()
        .filter(|v| *v > 0 && *v <= 9_007_199_254_740_991)
        .ok_or_else(|| INVALID.into())
}
fn session(value: Value) -> Result<Value, String> {
    Ok(
        json!({"accessToken":text(&value["access_token"])?, "refreshToken":text(&value["refresh_token"])?,
        "expiresIn":id(&value["expires_in"])?, "refreshTokenExpiresIn":id(&value["refresh_token_expires_in"])?}),
    )
}
pub(crate) fn execute(
    config: &Configuration,
    operation: Operation,
    body: Value,
) -> Result<Value, String> {
    execute_with(config, operation, body, github_http::send)
}
fn execute_with(
    config: &Configuration,
    operation: Operation,
    input: Value,
    mut send: impl FnMut(Request) -> Result<Value, String>,
) -> Result<Value, String> {
    if config.client_id.is_empty()
        || !config.client_id.bytes().all(|b| b.is_ascii_alphanumeric())
        || config.client_secret.is_empty()
        || config.client_secret.len() > 1024
        || config.client_secret.bytes().any(|b| b <= 32 || b == 127)
        || !input.is_object()
    {
        return Err(INVALID.into());
    }
    let app = || Authentication::App {
        client_id: config.client_id.clone(),
        client_secret: config.client_secret.clone(),
    };
    let oauth = |body| Request {
        method: Method::POST,
        url: "https://github.com/login/oauth/access_token".into(),
        authentication: Authentication::None,
        body,
        safe: false,
        revoke: false,
    };
    match operation {
        Operation::Exchange => {
            let code = text(&input["code"])?;
            let verifier = text(&input["codeVerifier"])?;
            if !(43..=128).contains(&verifier.len())
                || !verifier
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._~-".contains(&b))
            {
                return Err(INVALID.into());
            }
            let redirect = text(&input["redirectUri"])?;
            let url = reqwest::Url::parse(redirect).map_err(|_| INVALID)?;
            if url.scheme() != "http"
                || url.host_str() != Some("127.0.0.1")
                || url.port().unwrap_or(0) < 1024
                || !url.username().is_empty()
                || url.password().is_some()
                || url.path() != "/github/callback"
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err(INVALID.into());
            }
            session(send(oauth(
                json!({"client_id":config.client_id,"client_secret":config.client_secret,"code":code,"code_verifier":verifier,"redirect_uri":redirect}),
            ))?)
        }
        Operation::Refresh => session(send(oauth(
            json!({"client_id":config.client_id,"client_secret":config.client_secret,"grant_type":"refresh_token","refresh_token":text(&input["refreshToken"])?}),
        ))?),
        Operation::RevokeToken | Operation::RevokeAuthorization => {
            let target = if matches!(operation, Operation::RevokeToken) {
                "token"
            } else {
                "grant"
            };
            send(Request {
                method: Method::DELETE,
                url: format!(
                    "https://api.github.com/applications/{}/{target}",
                    config.client_id
                ),
                authentication: app(),
                body: json!({"access_token":text(&input["accessToken"])?}),
                safe: true,
                revoke: true,
            })?;
            Ok(json!({"revoked":true}))
        }
        Operation::Scope => {
            let token = text(&input["accessToken"])?;
            let owner = id(&input["ownerId"])?;
            let changes = input["allowChanges"].as_bool().ok_or(INVALID)?;
            let all = input
                .get("allRepositories")
                .map(|v| v.as_bool().ok_or(INVALID))
                .transpose()?
                .unwrap_or(false);
            let repositories = input["repositoryIds"].as_array().ok_or(INVALID)?;
            if repositories.len() > 500
                || (all && !repositories.is_empty())
                || (!all && repositories.is_empty())
            {
                return Err(INVALID.into());
            }
            let ids: Vec<u64> = repositories.iter().map(id).collect::<Result<_, _>>()?;
            if ids.iter().collect::<std::collections::HashSet<_>>().len() != ids.len() {
                return Err(INVALID.into());
            }
            let mut permissions = None;
            for page in 1..=20 {
                let result = send(Request {
                    method: Method::GET,
                    url: format!(
                        "https://api.github.com/user/installations?per_page=100&page={page}"
                    ),
                    authentication: Authentication::Bearer(token.into()),
                    body: Value::Null,
                    safe: true,
                    revoke: false,
                })?;
                let installations = result["installations"]
                    .as_array()
                    .ok_or("GitHub returned an invalid installation list.")?;
                for installation in installations {
                    if installation["account"]["id"].as_u64() != Some(owner)
                        || installation["client_id"] != config.client_id
                        || !installation["suspended_at"].is_null()
                    {
                        continue;
                    }
                    let mut selected = Map::new();
                    for (name, level) in installation["permissions"]
                        .as_object()
                        .ok_or("GitHub returned invalid App permissions.")?
                    {
                        if !REPOSITORY_PERMISSIONS.contains(&name.as_str()) {
                            return Err("The GitHub App has unsupported or non-repository permissions. Its administrator must remove them before Silo can grant sandbox access.".into());
                        }
                        if !matches!(level.as_str(), Some("read" | "write" | "admin")) {
                            return Err("GitHub returned invalid App permissions.".into());
                        }
                        if !changes && matches!(name.as_str(), "workflows" | "codespaces_secrets") {
                            continue;
                        }
                        selected.insert(
                            name.clone(),
                            if changes {
                                level.clone()
                            } else {
                                json!("read")
                            },
                        );
                    }
                    selected.insert("metadata".into(), json!("read"));
                    permissions = Some(selected);
                    break;
                }
                if permissions.is_some() || installations.len() < 100 {
                    break;
                }
                if page == 20 {
                    return Err("Too many GitHub installations to resolve safely.".into());
                }
            }
            let permissions = permissions.ok_or("This GitHub owner is not authorized for Silo.")?;
            let mut body =
                json!({"access_token":token,"target_id":owner,"permissions":permissions});
            if !all {
                body["repository_ids"] = json!(ids);
            }
            let result = send(Request {
                method: Method::POST,
                url: format!(
                    "https://api.github.com/applications/{}/token/scoped",
                    config.client_id
                ),
                authentication: app(),
                body,
                safe: false,
                revoke: false,
            })?;
            let expires = text(&result["expires_at"])?;
            let parsed = time::OffsetDateTime::parse(
                expires,
                &time::format_description::well_known::Rfc3339,
            )
            .map_err(|_| "GitHub returned an invalid token expiration.")?;
            if parsed <= time::OffsetDateTime::now_utc() {
                return Err("GitHub returned an expired token.".into());
            }
            Ok(json!({"accessToken":text(&result["token"])?,"expiresAt":expires}))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> Configuration {
        Configuration {
            client_id: "Iv23test".into(),
            client_secret: "fixture-secret".into(),
        }
    }
    fn input() -> Value {
        json!({"accessToken":"parent-fixture","ownerId":7,"repositoryIds":[11,12],"allowChanges":false})
    }
    fn installation(permissions: Value) -> Value {
        json!({"account":{"id":7},"client_id":"Iv23test","suspended_at":null,"permissions":permissions})
    }
    fn scoped() -> Value {
        json!({"token":"scoped-fixture","expires_at":"2099-01-01T00:00:00Z"})
    }
    #[test]
    fn code_exchange_carries_pkce_directly_and_requires_rotating_session() {
        let result=execute_with(&config(),Operation::Exchange,json!({"code":"fixture-code","codeVerifier":"a".repeat(43),"redirectUri":"http://127.0.0.1:4321/github/callback"}),|r| {
            assert_eq!(r.url,"https://github.com/login/oauth/access_token"); assert!(!r.safe);
            assert_eq!(r.body["code_verifier"],"a".repeat(43)); assert_eq!(r.body["client_secret"],"fixture-secret");
            Ok(json!({"access_token":"access","refresh_token":"refresh","expires_in":28800,"refresh_token_expires_in":15811200}))
        }).unwrap();
        assert_eq!(result["accessToken"], "access");
        assert!(session(json!({"access_token":"access"})).is_err());
    }
    #[test]
    fn callback_and_verifier_are_validated_before_network() {
        for redirect in [
            "https://127.0.0.1:4321/github/callback",
            "http://localhost:4321/github/callback",
            "http://127.0.0.1/github/callback",
            "http://127.0.0.1:4321/other",
            "http://127.0.0.1:4321/github/callback?x=1",
        ] {
            assert!(execute_with(
                &config(),
                Operation::Exchange,
                json!({"code":"code","codeVerifier":"a".repeat(43),"redirectUri":redirect}),
                |_| panic!("unexpected network")
            )
            .is_err());
        }
        assert!(execute_with(&config(),Operation::Exchange,json!({"code":"code","codeVerifier":"short","redirectUri":"http://127.0.0.1:4321/github/callback"}), |_|panic!("unexpected network")).is_err());
    }
    #[test]
    fn refresh_and_each_revocation_have_distinct_contracts() {
        execute_with(&config(),Operation::Refresh,json!({"refreshToken":"refresh"}),|r| {assert_eq!(r.body["grant_type"],"refresh_token");assert!(!r.safe);Ok(json!({"access_token":"access","refresh_token":"new-refresh","expires_in":1,"refresh_token_expires_in":2}))}).unwrap();
        for (operation, path) in [
            (Operation::RevokeToken, "token"),
            (Operation::RevokeAuthorization, "grant"),
        ] {
            execute_with(&config(), operation, json!({"accessToken":"access"}), |r| {
                assert_eq!(r.method, Method::DELETE);
                assert!(r.safe && r.revoke);
                assert!(r.url.ends_with(path));
                assert_eq!(r.body["access_token"], "access");
                match r.authentication {
                    Authentication::App {
                        client_id,
                        client_secret,
                    } => {
                        assert_eq!(client_id, "Iv23test");
                        assert_eq!(client_secret, "fixture-secret");
                    }
                    _ => panic!("App authentication required"),
                };
                Ok(json!({"revoked":true}))
            })
            .unwrap();
        }
    }
    #[test]
    fn scoped_read_omits_write_only_authority_and_binds_owner_and_repositories() {
        let mut calls = 0;
        execute_with(&config(),Operation::Scope,input(),|r| {calls+=1;if calls==1 {assert!(r.safe);return Ok(json!({"installations":[installation(json!({"contents":"write","workflows":"write","codespaces_secrets":"write","issues":"admin"}))]}));}
            assert!(!r.safe);assert_eq!(r.body["target_id"],7);assert_eq!(r.body["repository_ids"],json!([11,12]));assert_eq!(r.body["permissions"],json!({"contents":"read","issues":"read","metadata":"read"}));Ok(scoped())
        }).unwrap();
        assert_eq!(calls, 2);
    }
    #[test]
    fn all_mode_omits_repo_filter_and_write_preserves_app_permissions() {
        let mut request = input();
        request["allRepositories"] = json!(true);
        request["repositoryIds"] = json!([]);
        request["allowChanges"] = json!(true);
        execute_with(&config(),Operation::Scope,request,|r| {if r.method==Method::GET {return Ok(json!({"installations":[installation(json!({"contents":"write","workflows":"write"}))]}));}assert!(r.body.get("repository_ids").is_none());assert_eq!(r.body["permissions"],json!({"contents":"write","workflows":"write","metadata":"read"}));Ok(scoped())}).unwrap();
    }
    #[test]
    fn invalid_scope_inputs_never_reach_github() {
        for (key, value) in [
            ("repositoryIds", json!([])),
            ("repositoryIds", json!([1, 1])),
            ("repositoryIds", json!([0])),
            ("repositoryIds", json!([9007199254740992u64])),
            ("repositoryIds", json!(vec![1; 501])),
            ("ownerId", json!(-1)),
            ("allowChanges", json!("yes")),
            ("allRepositories", json!(true)),
        ] {
            let mut request = input();
            request[key] = value;
            assert!(
                execute_with(&config(), Operation::Scope, request, |_| panic!(
                    "unexpected request"
                ))
                .is_err()
            );
        }
    }
    #[test]
    fn incompatible_installations_and_permissions_never_mint() {
        let valid = installation(json!({"contents":"read"}));
        let mut other_app = valid.clone();
        other_app["client_id"] = json!("other");
        let mut other_owner = valid.clone();
        other_owner["account"]["id"] = json!(8);
        let mut suspended = valid.clone();
        suspended["suspended_at"] = json!("2026-01-01");
        for item in [
            other_app,
            other_owner,
            suspended,
            installation(json!({"organization_administration":"write"})),
            installation(json!({"unknown":"read"})),
            installation(json!({"contents":"owner"})),
        ] {
            assert!(execute_with(&config(), Operation::Scope, input(), |r| {
                assert_eq!(r.method, Method::GET);
                Ok(json!({"installations":[item.clone()]}))
            })
            .is_err());
        }
    }
    #[test]
    fn pagination_is_bounded_and_expired_tokens_fail_closed() {
        let mut calls = 0;
        assert!(execute_with(&config(), Operation::Scope, input(), |_| {
            calls += 1;
            Ok(json!({"installations":vec![json!({});100]}))
        })
        .is_err());
        assert_eq!(calls, 20);
        for result in [
            json!({"token":"scoped","expires_at":"yesterday"}),
            json!({"token":"scoped","expires_at":"2000-01-01T00:00:00Z"}),
            json!({"token":"","expires_at":"2099-01-01T00:00:00Z"}),
        ] {
            assert!(execute_with(&config(), Operation::Scope, input(), |r| {
                if r.method == Method::GET {
                    Ok(json!({"installations":[installation(json!({"contents":"read"}))]}))
                } else {
                    Ok(result.clone())
                }
            })
            .is_err());
        }
    }
}
