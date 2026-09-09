//! Explicit hardware integration test. Uses only a disposable managed VM and
//! synthetic or explicitly authorized scoped test credentials. Run with signed
//! SILO_TEST_MSB and SILO_TEST_LIBKRUNFW.
use super::*;

#[test]
#[ignore = "requires a signed MicroSandbox binary, hypervisor access and Ubuntu package network access"]
fn github_guest_bootstrap_and_live_identity() {
    let executable = PathBuf::from(std::env::var("SILO_TEST_MSB").expect("set SILO_TEST_MSB"));
    let library =
        PathBuf::from(std::env::var("SILO_TEST_LIBKRUNFW").expect("set SILO_TEST_LIBKRUNFW"));
    let directory = tempfile::Builder::new()
        .prefix("silo-gh-test-")
        .tempdir_in("/tmp")
        .unwrap();
    let paths = RuntimePaths {
        executable,
        library,
        home: directory.path().join("msb"),
        storage_home: None,
        metadata: directory.path().join("machines.json"),
        volumes: directory.path().join("volumes"),
    };
    let name = "github-integration-test";
    let runner = ProcessRunner;
    let run = |args: &[&str], timeout| {
        runner.run(
            &paths,
            &args.iter().map(|s| (*s).into()).collect::<Vec<_>>(),
            timeout,
        )
    };
    let result = (|| -> Result<(), String> {
        create_disposable_test_machine(&paths, name).map_err(|e| e.to_string())?;
        let initial = inspect_workspace(&runner, &paths, name).map_err(|e| e.to_string())?;
        if initial.status != "Stopped" {
            return Err("Bootstrap did not restore stopped state".into());
        }
        let host = host_resources().map_err(|e| e.to_string())?;
        workspace_action_with(&runner, &paths, &host, "start", name).map_err(|e| e.to_string())?;
        apply_disposable_test_identity(&paths, name).map_err(|e| e.to_string())?;
        let output = run(
            &[
                "exec",
                name,
                "--no-tty",
                "--quiet",
                "--timeout",
                "30s",
                "--",
                "sh",
                "-c",
                r#"set -eu
 git --version
 git lfs version
 gh --version
 [ "$GH_TOKEN" = '$MSB_SILO_GITHUB' ]
 git var GIT_AUTHOR_IDENT
 printf 'protocol=https\nhost=github.com\n\n' | git credential fill
 "#,
            ],
            MUTATION_TIMEOUT,
        )
        .map_err(|e| e.to_string())?;
        if !output
            .stdout
            .contains("Silo Test <silo-test@example.invalid>")
            || !output.stdout.contains("password=$MSB_SILO_GITHUB")
        {
            return Err("Guest identity or placeholder credential was not verified".into());
        }

        let result = run(
            &[
                "exec",
                name,
                "--no-tty",
                "--quiet",
                "--timeout",
                "30s",
                "--",
                "sh",
                "-c",
                r#"set -eu
 if gh api meta >/tmp/silo-test-response 2>/tmp/silo-test-error; then exit 1; fi
 GH_TOKEN=silo_nonsecret_invalid_probe gh api meta --include >/tmp/silo-test-trust 2>&1 || true
 grep -q 'HTTP/.*401' /tmp/silo-test-trust
 "#,
            ],
            MUTATION_TIMEOUT,
        );
        result.map_err(|e| format!("Disabled access and independent TLS check failed: {e}"))?;
        let profile = serde_json::json!({"version":1,"owners":[{
            "login":"silo-test","readToken":"silo_nonsecret_invalid_probe",
            "writeToken":null,"repositoryIds":[],"expiresAt":4102444800u64
        }]});
        // Exercise the actual app lifecycle argument construction, not a hand-
        // written msb command that could hide credential target wiring errors.
        GITHUB_PROFILES
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap()
            .insert((paths.home.clone(), name.into()), profile.to_string());
        workspace_action_with(&runner, &paths, &host, "stop", name).map_err(|e| e.to_string())?;
        for action in ["start", "restart"] {
            workspace_action_with(&runner, &paths, &host, action, name)
                .map_err(|e| e.to_string())?;
            let response = run(
                &[
                    "exec",
                    name,
                    "--no-tty",
                    "--quiet",
                    "--timeout",
                    "30s",
                    "--",
                    "sh",
                    "-c",
                    "gh api meta --include 2>&1 || true",
                ],
                MUTATION_TIMEOUT,
            )
            .map_err(|e| e.to_string())?
            .stdout;
            if !response.contains("HTTP/") || !response.contains("401") {
                return Err(format!(
                    "Production {action} did not attach the configured GitHub profile"
                ));
            }
        }
        let boot_id = run(
            &[
                "exec",
                name,
                "--no-tty",
                "--quiet",
                "--",
                "cat",
                "/proc/sys/kernel/random/boot_id",
            ],
            READ_TIMEOUT,
        )
        .map_err(|e| e.to_string())?
        .stdout;
        for (profile, should_reach_github) in [
            (profile.to_string(), true),
            (DISABLED_GITHUB_PROFILE.into(), false),
        ] {
            GITHUB_PROFILES
                .get_or_init(|| Mutex::new(HashMap::new()))
                .lock()
                .unwrap()
                .insert((paths.home.clone(), name.into()), profile);
            run(
                &[
                    "modify",
                    name,
                    "--secret",
                    "SILO_GITHUB@github.com,api.github.com,uploads.github.com",
                    "--format",
                    "json",
                ],
                MUTATION_TIMEOUT,
            )
            .map_err(|e| e.to_string())?;
            let response = run(
                &[
                    "exec",
                    name,
                    "--no-tty",
                    "--quiet",
                    "--timeout",
                    "30s",
                    "--",
                    "sh",
                    "-c",
                    "gh api meta --include 2>&1 || true",
                ],
                MUTATION_TIMEOUT,
            )
            .map_err(|e| e.to_string())?
            .stdout;
            let reached_github = response.contains("HTTP/") && response.contains("401");
            if reached_github != should_reach_github {
                return Err("Live GitHub profile change was not enforced".into());
            }
        }
        let after = run(
            &[
                "exec",
                name,
                "--no-tty",
                "--quiet",
                "--",
                "cat",
                "/proc/sys/kernel/random/boot_id",
            ],
            READ_TIMEOUT,
        )
        .map_err(|e| e.to_string())?
        .stdout;
        if after != boot_id {
            return Err("GitHub profile update restarted the VM".into());
        }
        crate::host_push::verify_disposable_binary_transfer(&paths, name)?;
        if inspect_workspace(&runner, &paths, name)
            .map_err(|e| e.to_string())?
            .status
            != "Running"
        {
            return Err("Live identity check did not preserve the running VM".into());
        }
        Ok(())
    })();
    // Cleanup is attempted on every result, including failed creation/provisioning.
    let stopped = run(&["stop", name], MUTATION_TIMEOUT);
    let removed = run(&["remove", "--force", name], MUTATION_TIMEOUT);
    GITHUB_PROFILES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap()
        .remove(&(paths.home.clone(), name.into()));
    assert!(result.is_ok(), "{}", result.unwrap_err());
    assert!(stopped.is_ok(), "Disposable VM could not be stopped");
    assert!(removed.is_ok(), "Disposable VM could not be removed");
}

/// Invoked by github_live_tests with SILO_GITHUB_TEST_VM=1.
/// Credentials are supplied only in the host environment, never test output.
#[test]
#[ignore = "requires explicitly authorized private test repositories and live scoped GitHub credentials"]
fn github_authenticated_guest_workflow() {
    let required = |key: &str| std::env::var(key).unwrap_or_else(|_| panic!("set {key}"));
    let raw_profile = required("SILO_TEST_GITHUB_PROFILE_JSON");
    let profile: Value = serde_json::from_str(&raw_profile).expect("invalid test profile");
    let read_repo = required("SILO_GITHUB_TEST_READ_REPO");
    let write_repo = required("SILO_GITHUB_TEST_WRITE_REPO");
    let denied_repo = required("SILO_GITHUB_TEST_DENIED_REPO");
    for repo in [&read_repo, &write_repo, &denied_repo] {
        assert!(
            repo.split('/').count() == 2
                && repo.split('/').all(|part| !part.is_empty()
                    && part
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))),
            "invalid fixture repository"
        );
    }
    assert!(read_repo != write_repo && read_repo != denied_repo && write_repo != denied_repo);
    let secret_values: Vec<String> = profile["owners"]
        .as_array()
        .expect("missing profile owners")
        .iter()
        .flat_map(|owner| [owner["readToken"].as_str(), owner["writeToken"].as_str()])
        .flatten()
        .map(str::to_owned)
        .collect();
    assert!(secret_values.len() >= 2, "missing scoped test credentials");
    let directory = tempfile::Builder::new()
        .prefix("silo-gh-live-")
        .tempdir_in("/tmp")
        .unwrap();
    let paths = RuntimePaths {
        executable: PathBuf::from(required("SILO_TEST_MSB")),
        library: PathBuf::from(required("SILO_TEST_LIBKRUNFW")),
        home: directory.path().join("msb"),
        storage_home: None,
        metadata: directory.path().join("machines.json"),
        volumes: directory.path().join("volumes"),
    };
    let name = "github-authenticated-test";
    let branch = format!("silo-integration-{}", uuid::Uuid::new_v4().simple());
    let runner = ProcessRunner;
    let run = |args: &[String]| runner.run(&paths, args, MUTATION_TIMEOUT);
    let guest = |script: &str| {
        run(&[
            "exec".into(),
            name.into(),
            "--no-tty".into(),
            "--quiet".into(),
            "--timeout".into(),
            "120s".into(),
            "--".into(),
            "sh".into(),
            "-c".into(),
            script.into(),
            "silo-test".into(),
            read_repo.clone(),
            write_repo.clone(),
            denied_repo.clone(),
            branch.clone(),
        ])
    };
    let install = |value: &Value| -> Result<(), String> {
        GITHUB_PROFILES
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap()
            .insert((paths.home.clone(), name.into()), value.to_string());
        run(&[
            "modify".into(),
            name.into(),
            "--secret".into(),
            "SILO_GITHUB@github.com,api.github.com,uploads.github.com".into(),
            "--format".into(),
            "json".into(),
        ])
        .map(|_| ())
        .map_err(|_| "Live test credential update failed.".into())
    };
    let mut created = false;
    let result = (|| -> Result<(), String> {
        create_disposable_test_machine(&paths, name)
            .map_err(|_| "Live test VM bootstrap failed.")?;
        created = true;
        GITHUB_PROFILES
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap()
            .insert((paths.home.clone(), name.into()), raw_profile.clone());
        workspace_action_with(
            &runner,
            &paths,
            &host_resources().map_err(|_| "Cannot measure host resources.")?,
            "start",
            name,
        )
        .map_err(|_| "Production Start failed for authenticated test VM.")?;
        apply_disposable_test_identity(&paths, name)
            .map_err(|_| "Live test identity setup failed.")?;
        let exposed = guest("env; git config --list --show-origin; printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill")
            .map_err(|_| "Guest credential boundary check failed.")?.stdout;
        if secret_values.iter().any(|secret| exposed.contains(secret)) {
            return Err("A real credential was exposed inside the guest.".into());
        }
        let boot = guest("cat /proc/sys/kernel/random/boot_id")
            .map_err(|_| "Cannot read test boot ID.")?
            .stdout;
        guest(
            r#"set -eu
mkdir -p /workspace/silo-live
cd /workspace/silo-live
git clone "https://github.com/$1.git" read >/dev/null 2>&1
git clone "https://github.com/$2.git" write >/dev/null 2>&1
if git ls-remote "https://github.com/$3.git" >/dev/null 2>&1; then exit 1; fi
gh api "repos/$1" >/dev/null
if gh api "repos/$3" >/dev/null 2>&1; then exit 1; fi
cd read
git checkout -b "$4" >/dev/null 2>&1
git commit --allow-empty -m 'Silo read-only boundary test' >/dev/null
if git push origin "HEAD:refs/heads/$4" >/dev/null 2>&1; then
 git push origin --delete "$4" >/dev/null 2>&1 || true
 exit 1
fi
cd ../write
git checkout -b "$4" >/dev/null 2>&1
git lfs track silo-live.bin >/dev/null
head -c 1048576 /dev/urandom >silo-live.bin
sha256sum silo-live.bin >/workspace/silo-live/expected.sha256
git add .gitattributes silo-live.bin
git commit -m 'Silo isolated Git LFS integration test' >/dev/null
git push origin "HEAD:refs/heads/$4" >/dev/null 2>&1
cd ..
git clone --branch "$4" "https://github.com/$2.git" roundtrip >/dev/null 2>&1
cd roundtrip
sha256sum -c /workspace/silo-live/expected.sha256 >/dev/null
"#,
        )
        .map_err(|_| "Authenticated Git, gh, LFS, or repository boundary test failed.")?;
        let mut readonly = profile.clone();
        for owner in readonly["owners"]
            .as_array_mut()
            .ok_or("Missing test profile owners.")?
        {
            owner["writeToken"] = Value::Null;
        }
        install(&readonly)?;
        guest(
            r#"set -eu
cd /workspace/silo-live/write
git fetch origin >/dev/null 2>&1
git commit --allow-empty -m 'Silo live write removal test' >/dev/null
if git push origin "HEAD:refs/heads/$4" >/dev/null 2>&1; then exit 1; fi
"#,
        )
        .map_err(|_| "Live write removal was not enforced.")?;
        install(&json!({"version":1,"owners":[]}))?;
        guest(
            r#"set -eu
if git ls-remote "https://github.com/$1.git" >/dev/null 2>&1; then exit 1; fi
if gh api "repos/$2" >/dev/null 2>&1; then exit 1; fi
"#,
        )
        .map_err(|_| "Live access disablement was not enforced.")?;
        install(&profile)?;
        guest(
            r#"set -eu
git ls-remote "https://github.com/$1.git" >/dev/null 2>&1
gh api "repos/$2" >/dev/null
"#,
        )
        .map_err(|_| "Live access restoration failed.")?;
        if guest("cat /proc/sys/kernel/random/boot_id")
            .map_err(|_| "Cannot verify boot ID.")?
            .stdout
            != boot
        {
            return Err("Live access changes restarted the test VM.".into());
        }
        Ok(())
    })();
    // Remove only our random branch; never modify the default branch. LFS test
    // objects can remain in GitHub storage after branch deletion, as documented.
    let cleanup = if created {
        install(&profile).and_then(|_| {
            guest(
                r#"set -eu
cleanup_failed=0
for directory in /workspace/silo-live/read /workspace/silo-live/write; do
 [ -d "$directory/.git" ] || continue
 if ! remote_branch=$(git -C "$directory" ls-remote origin "refs/heads/$4" 2>/dev/null); then
  cleanup_failed=1
 elif [ -n "$remote_branch" ]; then
  git -C "$directory" push origin --delete "$4" >/dev/null 2>&1 || cleanup_failed=1
 fi
done
exit "$cleanup_failed"
"#,
            )
            .map(|_| ())
            .map_err(|_| "Could not remove live test branch.".into())
        })
    } else {
        Ok(())
    };
    let _ = run(&["stop".into(), name.into()]);
    let _ = run(&["remove".into(), "--force".into(), name.into()]);
    let absent = run(&["list".into(), "--format".into(), "json".into()])
        .ok()
        .and_then(|output| serde_json::from_str::<Vec<ListedSandbox>>(&output.stdout).ok())
        .is_some_and(|sandboxes| sandboxes.iter().all(|sandbox| sandbox.name != name));
    GITHUB_PROFILES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap()
        .remove(&(paths.home.clone(), name.into()));
    assert!(
        cleanup.is_ok() && absent,
        "Live test cleanup failed. Inspect both explicit fixture repositories for the unique test branch and the disposable VM. Main workflow passed: {}",
        result.is_ok()
    );
    assert!(result.is_ok(), "{}", result.unwrap_err());
}
