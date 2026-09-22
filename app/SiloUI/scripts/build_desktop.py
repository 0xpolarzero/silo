"""Build desktop apps, finalizing the VM signature on local macOS bundles."""
import argparse
import json
from pathlib import Path
import subprocess
import sys

from macos_release_signing import sign_runtime, verify_bundle

APP = Path(__file__).resolve().parent.parent


def build(arguments, *, root=APP, platform=sys.platform, run=subprocess.run):
    root = Path(root).resolve()
    tauri = ['node', str(root / 'node_modules/@tauri-apps/cli/tauri.js'), 'build']
    parser = argparse.ArgumentParser(add_help=False, allow_abbrev=False)
    parser.add_argument('--debug', '-d', action='store_true')
    parser.add_argument('--no-bundle', action='store_true')
    parser.add_argument('--help', '-h', action='store_true')
    parser.add_argument('--version', '-V', action='store_true')
    parser.add_argument('--target', '-t')
    parser.add_argument('--bundles', '-b', nargs='+')
    options, _ = parser.parse_known_args(arguments)
    if (platform != 'darwin' or options.debug or options.no_bundle or options.help or options.version
            or (options.target and not options.target.endswith('apple-darwin'))):
        run(tauri + arguments, cwd=root, check=True)
        return None
    if options.target and options.target != 'aarch64-apple-darwin':
        raise ValueError('Local macOS bundles require the supported aarch64-apple-darwin target.')
    if options.bundles is not None and options.bundles != ['app']:
        raise ValueError('Local macOS builds support --bundles app. Use the release workflow for DMG and updater packages.')
    if '--' in arguments:
        raise ValueError('Use CARGO_TARGET_DIR for a separate local bundle output; raw Cargo arguments require --no-bundle.')

    metadata = run(['cargo', 'metadata', '--format-version', '1', '--no-deps', '--locked'],
                   cwd=root / 'src-tauri', check=True, capture_output=True, text=True)
    target = Path(json.loads(metadata.stdout)['target_directory'])
    if options.target:
        target /= options.target
    bundle = target / 'release/bundle/macos/Silo.app'
    # Generate only the app here. Installers and updater archives must be made
    # after runtime finalization by package-macos-release.py.
    config = json.dumps({'bundle': {'active': True, 'createUpdaterArtifacts': False,
                                    'macOS': {'hardenedRuntime': True}}})
    args = arguments + ([] if options.bundles else ['--bundles', 'app'])
    run(tauri + args + ['--config', config], cwd=root, check=True)
    sign_runtime(bundle)
    verify_bundle(bundle)
    return bundle


if __name__ == '__main__':
    try:
        bundle = build(sys.argv[1:])
        if bundle:
            print(f'Verified local macOS app: {bundle}')
    except (ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f'Desktop build failed: {error}', file=sys.stderr)
        sys.exit(1)
