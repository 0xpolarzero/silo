//! Acknowledge one observed crash without editing MicroSandbox's state or disks.
use super::*;
use serde_json::json;

fn machine(paths: &RuntimePaths, name: &str) -> Result<MachineConfiguration, RuntimeError> {
    validate_name(name)?;
    read_metadata(&paths.metadata)?
        .machines
        .into_iter()
        .find(|m| m.is_vm() && m.name() == name)
        .ok_or_else(|| RuntimeError::Invalid("This sandbox no longer exists.".into()))
}
fn path(paths: &RuntimePaths, machine: &MachineConfiguration) -> PathBuf {
    paths
        .metadata
        .with_file_name("acknowledged-crashes")
        .join(format!(
            "{:x}.json",
            Sha256::digest(machine.id().as_bytes())
        ))
}
fn fingerprint(machine: &MachineConfiguration, inspected: &InspectedSandbox) -> Option<String> {
    if inspected.name != machine.name()
        || inspected
            .config
            .pointer("/labels/silo.machine-id")
            .and_then(Value::as_str)
            != Some(machine.id())
    {
        return None;
    }
    let updated = inspected.updated_at.as_ref().filter(|s| !s.is_empty())?;
    Some(json!([machine.id(), machine.name(), updated]).to_string())
}
pub(super) fn is_acknowledged(
    paths: &RuntimePaths,
    machine: &MachineConfiguration,
    inspected: &InspectedSandbox,
) -> bool {
    fingerprint(machine, inspected).is_some_and(|expected| {
        fs::read_to_string(path(paths, machine)).is_ok_and(|saved| saved == expected)
    })
}
pub(super) fn dismiss(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    name: &str,
) -> Result<(), RuntimeError> {
    let machine = machine(paths, name)?;
    let inspected = inspect_workspace(runner, paths, name)?;
    ensure_managed(&inspected)?;
    if inspected.name != name
        || inspected
            .config
            .pointer("/labels/silo.machine-id")
            .and_then(Value::as_str)
            != Some(machine.id())
    {
        return Err(RuntimeError::Invalid(
            "The sandbox was replaced. Refresh before dismissing its error.".into(),
        ));
    }
    if inspected.status != "Crashed" {
        return Err(RuntimeError::Invalid(
            "The sandbox state changed. Refresh to see its current status.".into(),
        ));
    }
    let value = fingerprint(&machine, &inspected).ok_or_else(|| {
        RuntimeError::Invalid("The runtime did not identify this crash. Refresh and retry.".into())
    })?;
    lifecycle_recovery::dismiss_crashed_intent(paths, &machine)?;
    let target = path(paths, &machine);
    let directory = target.parent().unwrap();
    let save = || -> std::io::Result<()> {
        fs::create_dir_all(directory)?;
        let mut file = tempfile::NamedTempFile::new_in(directory)?;
        use std::io::Write;
        file.write_all(value.as_bytes())?;
        file.as_file().sync_all()?;
        file.persist(&target)?;
        File::open(directory)?.sync_all()
    };
    save().map_err(|_| RuntimeError::Unavailable("The crash could not be dismissed. Retry.".into()))?;
    runtime_activity::acknowledge_failure(paths, machine.id())
}
pub(super) fn clear(paths: &RuntimePaths, name: &str) -> Result<(), RuntimeError> {
    let machine = machine(paths, name)?;
    match fs::remove_file(path(paths, &machine)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(RuntimeError::Unavailable(
            "The previous crash acknowledgement could not be cleared.".into(),
        )),
    }
}
