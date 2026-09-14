#!/usr/bin/env python3
"""Experimental Cargo wrapper. Disabled unless an isolated cache is configured.

Only registry itoa 1.0.18 is reviewed for this probe. This is deliberately not
wired into CI; see the native workflow measurements before extending it.
"""
import os
from pathlib import Path
import subprocess
import sys

VERSION = 'sccache 0.12.0'


def eligible(args, env):
    try:
        manifest = Path(env['CARGO_MANIFEST_DIR']).resolve()
        registry = (Path(env.get('CARGO_HOME', Path.home() / '.cargo')) / 'registry/src').resolve()
        relative = manifest.relative_to(registry)
        return (len(relative.parts) == 2 and relative.parts[1] == 'itoa-1.0.18'
                and env.get('CARGO_PKG_NAME') == 'itoa'
                and env.get('CARGO_PKG_VERSION') == '1.0.18'
                and args[args.index('--crate-name') + 1] == 'itoa'
                and '--test' not in args
                and args[args.index('--crate-type') + 1] in ('lib', 'rlib')
                and any(arg.endswith('.rs') and Path(arg).resolve().is_relative_to(manifest) for arg in args))
    except (KeyError, ValueError, IndexError):
        return False


def main():
    rustc, *args = sys.argv[1:]
    env = os.environ
    cache = env.get('SILO_EXPERIMENT_SCCACHE')
    directory = env.get('SILO_EXPERIMENT_CACHE_DIR')
    mode = env.get('SILO_EXPERIMENT_CACHE_MODE', 'READ_ONLY')
    if not cache or not directory or mode not in ('READ_ONLY', 'READ_WRITE') or not eligible(args, env):
        return subprocess.call([rustc, *args])
    # No inherited config, remote backend, signing or GitHub variables reach
    # the isolated daemon. The writer therefore receives no app credentials.
    child = {key: env[key] for key in ('PATH', 'HOME', 'TMPDIR', 'RUSTUP_HOME', 'CARGO_HOME') if key in env}
    child.update(SCCACHE_DIR=directory, SCCACHE_LOCAL_RW_MODE=mode,
                 SCCACHE_CONF=os.devnull, SCCACHE_CACHED_CONF=os.devnull,
                 SCCACHE_SERVER_UDS=directory + '.' + mode + '.sock')
    try:
        version = subprocess.check_output([cache, '--version'], env=child, text=True).strip()
        if version != VERSION:
            return subprocess.call([rustc, *args])
        result = subprocess.call([cache, rustc, *args], env=child)
        if result == 0:
            return 0
    except (OSError, subprocess.CalledProcessError):
        pass
    # Cache startup, corruption, unsupported compilation and misses that fail
    # inside the cache can never prevent the ordinary compiler invocation.
    return subprocess.call([rustc, *args])


if __name__ == '__main__':
    sys.exit(main())
