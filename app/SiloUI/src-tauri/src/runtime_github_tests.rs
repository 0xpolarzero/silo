//! Explicit hardware integration test. Uses only a disposable managed VM and
//! synthetic credentials. Run with signed SILO_TEST_MSB and SILO_TEST_LIBKRUNFW.
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
        run(&["start", name], MUTATION_TIMEOUT).map_err(|e| e.to_string())?;
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
        let profile = serde_json::json!({"version":1,"owners":[{
            "login":"silo-test","readToken":"silo_nonsecret_invalid_probe",
            "writeToken":null,"repositoryIds":[],"expiresAt":4102444800u64
        }]});
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
