#!/bin/sh
# Run only in a disposable Linux guest/container with Go and strace installed.
# Usage: sh run-sync-probe.sh [private output parent]
set -eu

if [ "$(uname -s)" != Linux ]; then
    echo 'Linux is required' >&2
    exit 2
fi
command -v go >/dev/null 2>&1 || { echo 'go is required' >&2; exit 2; }
command -v strace >/dev/null 2>&1 || { echo 'strace is required' >&2; exit 2; }

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
output_parent=${1:-${TMPDIR:-/tmp}}
run_dir=$(mktemp -d "$output_parent/d2-sync-probe.XXXXXXXX")
chmod 700 "$run_dir"
mkdir "$run_dir/control" "$run_dir/fault"
: > "$run_dir/control/target"
: > "$run_dir/control/unrelated"
: > "$run_dir/fault/target"
: > "$run_dir/fault/unrelated"
go build -trimpath -o "$run_dir/sync_probe" "$script_dir/sync_probe.go"

strace -f -qq -yy -P "$run_dir/control/target" \
    -e trace=fsync,fdatasync \
    -o "$run_dir/control.strace" \
    "$run_dir/sync_probe" "$run_dir/control" control \
    > "$run_dir/control.stdout" 2> "$run_dir/control.stderr"

strace -f -qq -yy -P "$run_dir/fault/target" \
    -e trace=fsync,fdatasync \
    -e inject=fsync:error=EIO:when=1 \
    -o "$run_dir/fault.strace" \
    "$run_dir/sync_probe" "$run_dir/fault" fault \
    > "$run_dir/fault.stdout" 2> "$run_dir/fault.stderr"

grep -F 'fsync(' "$run_dir/control.strace" | grep -F '= 0' >/dev/null
grep -F 'fsync(' "$run_dir/fault.strace" | grep -F 'EIO' | grep -F 'INJECTED' >/dev/null
grep -F "$run_dir/fault/target" "$run_dir/fault.strace" >/dev/null
if grep -F "$run_dir/fault/unrelated" "$run_dir/fault.strace" >/dev/null; then
    echo 'unrelated file was traced under exact path filter' >&2
    exit 1
fi

printf 'PASS: actual File.Sync syscall returned injected EIO on exact target; unrelated sync succeeded\n'
printf 'evidence directory: %s\n' "$run_dir"
