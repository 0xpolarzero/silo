//! Opt-in authenticated regression. All diagnostics deliberately omit HTTP bodies and credentials.
use crate::github_tokens::{execute, Configuration, Operation};
use reqwest::blocking::Client;
use serde_json::{json, Value};
use std::{collections::HashMap, time::Duration};

type Check<T> = Result<T, &'static str>;
struct Repository {
    name: String,
    id: u64,
}
struct Fixture {
    app: Configuration,
    parent: String,
    repos: [Repository; 3],
}
fn required(env: &HashMap<String, String>, name: &str) -> Check<String> {
    env.get(name)
        .filter(|v| !v.is_empty() && !v.bytes().any(|c| c <= 32 || c == 127))
        .cloned()
        .ok_or("Missing or invalid regression configuration.")
}
fn configuration(env: &HashMap<String, String>) -> Check<Fixture> {
    ensure(
        env.get("SILO_GITHUB_TEST_CONFIRM").map(String::as_str)
            == Some("private-test-repositories"),
        "Explicit private fixture authorization is required.",
    )?;
    let repository = |role: &str| -> Check<Repository> {
        let name = required(env, &format!("SILO_GITHUB_TEST_{role}_REPO"))?;
        let parts: Vec<_> = name.split('/').collect();
        ensure(
            parts.len() == 2
                && !parts[0].is_empty()
                && parts[0]
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-')
                && !parts[1].is_empty()
                && ![".", ".."].contains(&parts[1])
                && parts[1]
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c)),
            "Invalid fixture repository name.",
        )?;
        let id = required(env, &format!("SILO_GITHUB_TEST_{role}_REPO_ID"))?
            .parse::<u64>()
            .map_err(|_| "Invalid fixture repository ID.")?;
        ensure(
            id > 0 && id <= 9_007_199_254_740_991,
            "Invalid fixture repository ID.",
        )?;
        Ok(Repository { name, id })
    };
    let repos = [
        repository("READ")?,
        repository("WRITE")?,
        repository("DENIED")?,
    ];
    for (i, a) in repos.iter().enumerate() {
        for b in repos.iter().skip(i + 1) {
            ensure(
                a.id != b.id
                    && !a.name.eq_ignore_ascii_case(&b.name)
                    && a.name
                        .split('/')
                        .next()
                        .unwrap()
                        .eq_ignore_ascii_case(b.name.split('/').next().unwrap()),
                "Use three distinct private fixture repositories under one owner.",
            )?;
        }
    }
    Ok(Fixture {
        app: Configuration {
            client_id: required(env, "SILO_GITHUB_CLIENT_ID")?,
            client_secret: required(env, "SILO_GITHUB_CLIENT_SECRET")?,
        },
        parent: required(env, "SILO_GITHUB_TEST_USER_TOKEN")?,
        repos,
    })
}
fn ensure(value: bool, message: &'static str) -> Check<()> {
    if value {
        Ok(())
    } else {
        Err(message)
    }
}
struct Api {
    client: Client,
}
impl Api {
    fn call(&self, token: &str, path: &str, body: Option<Value>) -> Check<(u16, Value)> {
        let builder = if body.is_some() {
            self.client.post(format!("https://api.github.com{path}"))
        } else {
            self.client.get(format!("https://api.github.com{path}"))
        };
        let builder = builder
            .bearer_auth(token)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28");
        let builder = if let Some(body) = body {
            builder.json(&body)
        } else {
            builder
        };
        let response = builder
            .send()
            .map_err(|_| "GitHub request failed; mutations were not retried.")?;
        let status = response.status().as_u16();
        let data = response
            .json()
            .map_err(|_| "GitHub response was invalid.")?;
        Ok((status, data))
    }
    fn graph(&self, token: &str, query: &str, variables: Value) -> Check<(u16, Value)> {
        self.call(
            token,
            "/graphql",
            Some(json!({"query":query,"variables":variables})),
        )
    }
}
fn graph_ok(response: &(u16, Value)) -> bool {
    response.0 == 200 && response.1.get("errors").is_none()
}
fn graph_denied(response: &(u16, Value)) -> bool {
    response.0 == 200
        && response.1["errors"].as_array().is_some_and(|errors| {
            errors
                .iter()
                .any(|e| matches!(e["type"].as_str(), Some("FORBIDDEN" | "NOT_FOUND")))
        })
}
fn scope(
    app: &Configuration,
    parent: &str,
    owner: u64,
    ids: &[u64],
    write: bool,
    children: &mut Vec<String>,
) -> Check<(String, u64)> {
    let value = execute(app, Operation::Scope, json!({"accessToken":parent,"ownerId":owner,"repositoryIds":ids,"allRepositories":ids.is_empty(),"allowChanges":write})).map_err(|_| "Native scoped-token operation failed.")?;
    let token = value["accessToken"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("Invalid scoped token.")?
        .to_owned();
    children.push(token.clone());
    let expiry = time::OffsetDateTime::parse(
        value["expiresAt"].as_str().ok_or("Missing token expiry.")?,
        &time::format_description::well_known::Rfc3339,
    )
    .map_err(|_| "Invalid token expiry.")?
    .unix_timestamp();
    ensure(
        expiry > time::OffsetDateTime::now_utc().unix_timestamp() + 120,
        "Scoped token expires too soon.",
    )?;
    Ok((token, expiry as u64))
}
const QUERY: &str =
    "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id nameWithOwner}}";
const UPDATE: &str =
    "mutation($input:UpdateIssueInput!){updateIssue(input:$input){issue{id title}}}";
fn verify(f: Fixture, vm: bool) -> Check<()> {
    let api = Api {
        client: Client::builder()
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("Silo-authenticated-regression")
            .build()
            .map_err(|_| "Cannot initialize regression client.")?,
    };
    let mut children = Vec::new();
    let mut issue_id = None;
    let result = (|| -> Check<()> {
        let mut repositories = Vec::new();
        for repo in &f.repos {
            let response = api.call(&f.parent, &format!("/repos/{}", repo.name), None)?;
            ensure(
                response.0 == 200
                    && response.1["id"].as_u64() == Some(repo.id)
                    && response.1["private"] == true
                    && response.1["full_name"]
                        .as_str()
                        .is_some_and(|name| name.eq_ignore_ascii_case(&repo.name)),
                "Fixture privacy, exact name, ID or parent authorization preflight failed.",
            )?;
            repositories.push(response.1);
        }
        let owner = repositories[0]["owner"]["id"]
            .as_u64()
            .ok_or("Missing fixture owner ID.")?;
        ensure(
            repositories
                .iter()
                .all(|r| r["owner"]["id"].as_u64() == Some(owner))
                && repositories[1]["has_issues"] == true,
            "Fixture owner or Issues preflight failed.",
        )?;
        let (read, read_expiry) = scope(
            &f.app,
            &f.parent,
            owner,
            &[f.repos[0].id, f.repos[1].id],
            false,
            &mut children,
        )?;
        let (write, write_expiry) = scope(
            &f.app,
            &f.parent,
            owner,
            &[f.repos[1].id],
            true,
            &mut children,
        )?;
        for (token, allowed) in [(&read, [true, true, false]), (&write, [false, true, false])] {
            for (repo, allowed) in f.repos.iter().zip(allowed) {
                ensure(
                    api.call(token, &format!("/repos/{}", repo.name), None)?.0
                        == if allowed { 200 } else { 404 },
                    "REST repository boundary failed.",
                )?;
                let parts: Vec<_> = repo.name.split('/').collect();
                let response =
                    api.graph(token, QUERY, json!({"owner":parts[0],"name":parts[1]}))?;
                ensure(
                    if allowed {
                        graph_ok(&response)
                            && response.1["data"]["repository"]["nameWithOwner"]
                                .as_str()
                                .is_some_and(|n| n.eq_ignore_ascii_case(&repo.name))
                    } else {
                        graph_denied(&response) && response.1["data"]["repository"].is_null()
                    },
                    "GraphQL repository boundary failed.",
                )?;
            }
        }
        let node = api.graph(
            &read,
            "query($id:ID!){node(id:$id){... on Repository{id nameWithOwner}}}",
            json!({"id":repositories[2]["node_id"]}),
        )?;
        ensure(
            graph_denied(&node) && node.1["data"]["node"].is_null(),
            "GraphQL node ID exposed denied repository.",
        )?;
        let marker = format!("Silo authenticated regression {}", uuid::Uuid::new_v4());
        let created = api.graph(&write, "mutation($input:CreateIssueInput!){createIssue(input:$input){issue{id number title}}}", json!({"input":{"repositoryId":repositories[1]["node_id"],"title":marker,"body":"Permanent Silo integration test; closed during cleanup."}}))?;
        issue_id = created.1["data"]["createIssue"]["issue"]["id"]
            .as_str()
            .map(str::to_owned);
        ensure(
            graph_ok(&created) && issue_id.is_some(),
            "Could not create isolated fixture issue.",
        )?;
        let number = created.1["data"]["createIssue"]["issue"]["number"]
            .as_u64()
            .ok_or("Missing fixture issue number.")?;
        let denied = api.graph(
            &read,
            UPDATE,
            json!({"input":{"id":issue_id,"title":"unexpected read mutation"}}),
        )?;
        ensure(
            graph_denied(&denied) && denied.1["data"]["updateIssue"]["issue"].is_null(),
            "Read token performed a node-ID write.",
        )?;
        let rest_denied = api
            .client
            .patch(format!(
                "https://api.github.com/repos/{}/issues/{number}",
                f.repos[1].name
            ))
            .bearer_auth(&read)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .json(&json!({"title":"unexpected REST read mutation"}))
            .send()
            .map_err(|_| "REST write probe failed.")?;
        ensure(
            matches!(rest_denied.status().as_u16(), 403 | 404),
            "Read token performed REST write or returned inconclusive response.",
        )?;
        let unchanged = api.call(
            &f.parent,
            &format!("/repos/{}/issues/{number}", f.repos[1].name),
            None,
        )?;
        ensure(
            unchanged.0 == 200 && unchanged.1["title"] == marker,
            "Denied mutation changed issue.",
        )?;
        let updated = api.graph(
            &write,
            UPDATE,
            json!({"input":{"id":issue_id,"title":format!("{marker} verified")}}),
        )?;
        ensure(graph_ok(&updated), "Allowed node-ID write failed.")?;
        // Ask GitHub to widen a child, as an attacker knowing the App client secret could.
        // Either refusal or an equally restricted result is safe. Track any issued token.
        let attempted = execute(
            &f.app,
            Operation::Scope,
            json!({"accessToken":read,"ownerId":owner,"repositoryIds":[],"allRepositories":true,"allowChanges":true}),
        );
        if let Ok(value) = attempted {
            let token = value["accessToken"]
                .as_str()
                .ok_or("Invalid re-scoped child.")?
                .to_owned();
            children.push(token.clone());
            ensure(
                api.call(&token, &format!("/repos/{}", f.repos[2].name), None)?
                    .0
                    == 404,
                "Child re-scope expanded repository access.",
            )?;
            ensure(
                graph_denied(&api.graph(
                    &token,
                    UPDATE,
                    json!({"input":{"id":issue_id,"title":"unexpected child escalation"}}),
                )?),
                "Child re-scope expanded write access.",
            )?;
        }
        let (probe_read, _) = scope(
            &f.app,
            &f.parent,
            owner,
            &[f.repos[0].id, f.repos[1].id],
            false,
            &mut children,
        )?;
        // Bypass Silo's scope preparation: GitHub itself must enforce parent bounds.
        for (method, suffix, body) in [
            (
                reqwest::Method::POST,
                "token/scoped",
                json!({"access_token":probe_read,"target_id":owner,"repository_ids":[f.repos[2].id],"permissions":{"contents":"write","issues":"write","metadata":"read"}}),
            ),
            (
                reqwest::Method::PATCH,
                "token",
                json!({"access_token":probe_read}),
            ),
        ] {
            let response = api
                .client
                .request(
                    method,
                    format!(
                        "https://api.github.com/applications/{}/{suffix}",
                        f.app.client_id
                    ),
                )
                .basic_auth(&f.app.client_id, Some(&f.app.client_secret))
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2022-11-28")
                .json(&body)
                .send()
                .map_err(|_| "Child escalation probe transport failed.")?;
            let status = response.status().as_u16();
            let data: Value = response
                .json()
                .map_err(|_| "Child escalation probe response invalid.")?;
            if status == 201 || status == 200 {
                let token = data["token"]
                    .as_str()
                    .or_else(|| data["access_token"].as_str())
                    .ok_or("Child escalation response omitted token.")?
                    .to_owned();
                children.push(token.clone());
                ensure(
                    api.call(&token, &format!("/repos/{}", f.repos[2].name), None)?
                        .0
                        == 404,
                    "GitHub child re-scope or reset expanded repository access.",
                )?;
                ensure(graph_denied(&api.graph(&token, UPDATE, json!({"input":{"id":issue_id,"title":"unexpected direct child escalation"}}))?), "GitHub child re-scope or reset expanded write access.")?;
            } else {
                ensure(
                    matches!(status, 403 | 404 | 422),
                    "Escalation probe did not produce a conclusive permission refusal.",
                )?;
            }
        }
        let (all, _) = scope(&f.app, &f.parent, owner, &[], false, &mut children)?;
        for repo in &f.repos {
            ensure(
                api.call(&all, &format!("/repos/{}", repo.name), None)?.0 == 200,
                "All repositories excluded authorized fixture.",
            )?;
        }
        execute(&f.app, Operation::RevokeToken, json!({"accessToken":all}))
            .map_err(|_| "Child revocation failed.")?;
        ensure(
            api.call(&all, "/user", None)?.0 == 401
                && api.call(&f.parent, "/user", None)?.0 == 200
                && api
                    .call(&read, &format!("/repos/{}", f.repos[0].name), None)?
                    .0
                    == 200,
            "Child revocation affected parent or sibling.",
        )?;
        children.retain(|token| token != &all);
        if vm {
            run_vm(
                &f,
                json!({"version":1,"owners":[{"login":f.repos[0].name.split('/').next().unwrap(),"repositoryIds":[f.repos[0].id,f.repos[1].id],"readToken":read,"writeToken":write,"expiresAt":read_expiry.min(write_expiry)}]}),
            )?;
        }
        Ok(())
    })();
    let mut cleanup_failed = false;
    if let Some(id) = issue_id {
        cleanup_failed |= !api
            .graph(
                &f.parent,
                "mutation($input:CloseIssueInput!){closeIssue(input:$input){issue{state}}}",
                json!({"input":{"issueId":id}}),
            )
            .is_ok_and(|r| graph_ok(&r) && r.1["data"]["closeIssue"]["issue"]["state"] == "CLOSED");
    }
    for token in children {
        cleanup_failed |=
            execute(&f.app, Operation::RevokeToken, json!({"accessToken":token})).is_err();
    }
    ensure(!cleanup_failed, "Cleanup unconfirmed: inspect only named fixture repository for test issue and revoke remaining test credentials.")?;
    result
}
fn run_vm(f: &Fixture, profile: Value) -> Check<()> {
    let mut command = std::process::Command::new("cargo");
    command.current_dir(env!("CARGO_MANIFEST_DIR")).env_clear();
    for key in [
        "PATH",
        "HOME",
        "TMPDIR",
        "CARGO_HOME",
        "RUSTUP_HOME",
        "SDKROOT",
        "DEVELOPER_DIR",
        "SILO_TEST_MSB",
        "SILO_TEST_LIBKRUNFW",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    for (role, repo) in ["READ", "WRITE", "DENIED"].into_iter().zip(&f.repos) {
        command.env(format!("SILO_GITHUB_TEST_{role}_REPO"), &repo.name);
    }
    let status = command
        .env("SILO_TEST_GITHUB_PROFILE_JSON", profile.to_string())
        .args([
            "test",
            "--offline",
            "github_authenticated_guest_workflow",
            "--",
            "--ignored",
            "--test-threads=1",
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|_| "Cannot launch authenticated guest regression.")?;
    ensure(
        status.success(),
        "Authenticated guest regression failed; output suppressed to protect credentials.",
    )
}
#[test]
#[ignore = "requires explicit private GitHub fixtures and credentials; mutates only a marked fixture issue"]
fn github_authenticated_native_workflow() {
    let env = std::env::vars().collect();
    let result = configuration(&env).and_then(|f| {
        verify(
            f,
            std::env::var("SILO_GITHUB_TEST_VM").as_deref() == Ok("1"),
        )
    });
    assert!(
        result.is_ok(),
        "{}",
        result.err().unwrap_or("Authenticated regression failed.")
    );
}
#[test]
fn live_configuration_rejects_missing_confirmation_and_unsafe_fixtures() {
    let mut env: HashMap<String, String> = [
        ("SILO_GITHUB_TEST_CONFIRM", "private-test-repositories"),
        ("SILO_GITHUB_CLIENT_ID", "app"),
        ("SILO_GITHUB_CLIENT_SECRET", "secret"),
        ("SILO_GITHUB_TEST_USER_TOKEN", "parent"),
        ("SILO_GITHUB_TEST_READ_REPO", "owner/read"),
        ("SILO_GITHUB_TEST_READ_REPO_ID", "1"),
        ("SILO_GITHUB_TEST_WRITE_REPO", "owner/write"),
        ("SILO_GITHUB_TEST_WRITE_REPO_ID", "2"),
        ("SILO_GITHUB_TEST_DENIED_REPO", "owner/denied"),
        ("SILO_GITHUB_TEST_DENIED_REPO_ID", "3"),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v.into()))
    .collect();
    assert!(configuration(&env).is_ok());
    for (key, value) in [
        ("SILO_GITHUB_TEST_CONFIRM", ""),
        ("SILO_GITHUB_TEST_READ_REPO", "owner/.."),
        ("SILO_GITHUB_TEST_WRITE_REPO", "other/write"),
        ("SILO_GITHUB_TEST_WRITE_REPO", "OWNER/READ"),
        ("SILO_GITHUB_TEST_WRITE_REPO_ID", "1"),
        ("SILO_GITHUB_TEST_READ_REPO_ID", "0"),
        ("SILO_GITHUB_TEST_READ_REPO_ID", "9007199254740992"),
        ("SILO_GITHUB_TEST_USER_TOKEN", "secret\n"),
    ] {
        let original = env.insert(key.into(), value.into()).unwrap();
        assert!(
            configuration(&env).is_err(),
            "Unsafe fixture accepted for {key}"
        );
        env.insert(key.into(), original);
    }
}

#[test]
fn live_denial_requires_github_permission_evidence() {
    assert!(graph_denied(&(
        200,
        json!({"errors":[{"type":"FORBIDDEN"}]})
    )));
    assert!(graph_denied(&(
        200,
        json!({"errors":[{"type":"NOT_FOUND"}]})
    )));
    for response in [
        (429, json!({"errors":[{"type":"FORBIDDEN"}]})),
        (500, json!({"errors":[{"type":"FORBIDDEN"}]})),
        (200, json!({"errors":[{"type":"RATE_LIMITED"}]})),
        (200, json!({"data":{"repository":null}})),
    ] {
        assert!(!graph_denied(&response));
    }
}
