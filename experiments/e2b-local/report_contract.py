"""Exact case names required before a PoC run can be called passed."""

QUALIFICATION_CASES = (
    'Kernel isolation, private egress and per-guest metadata',
    'LCU desktop, isolation, handoff and reconnect',
    'ARM64 Firefox observed through LCU',
    'SDK PTY resize, Unicode, signal and exit',
    'SSH binary, SFTP, EOF, exit status and revocation',
    'Checkpoint fork and revert preserve memory and renew identity',
)

CREDENTIAL_CASES = (
    'TLS credential substitution and negative authorization cases',
    'Git smart HTTP through TLS placeholder broker',
    'Rotation, revocation, guest-file scan and checkpoint replay',
)


def complete(report, expected):
    checks = report.get('checks', [])
    return (report.get('status') == 'passed'
            and len(checks) == len(expected)
            and {case.get('name') for case in checks} == set(expected)
            and all(case.get('status') == 'pass' for case in checks))


def same_candidate(first, second):
    a, b = first.get('manifest', {}), second.get('manifest', {})
    keys = ('source_sha256', 'template_build_record_sha256', 'sdk_version',
            'host_kernel', 'host_arch', 'boot_id')
    return all(a.get(key) and a.get(key) == b.get(key) for key in keys)
