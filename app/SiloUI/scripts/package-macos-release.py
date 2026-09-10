"""Produce matching DMG and signed update archive with constrained VM loading."""
import argparse
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
from macos_release_signing import sign_runtime, verify_bundle


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bundle', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    app, output = args.bundle.resolve(), args.output.resolve()
    if app.name != 'Silo.app' or not (app / 'Contents/MacOS/msb').is_file():
        raise RuntimeError('Expected a built Silo.app with its VM runtime.')
    key = os.environ.get('TAURI_SIGNING_PRIVATE_KEY', '')
    if not key:
        raise RuntimeError('An updater signing key is required.')
    output.mkdir(parents=True, exist_ok=True)
    archive = output / 'Silo-macos-arm64.app.tar.gz'
    dmg = output / 'Silo-macos-arm64.dmg'
    if any(path.exists() for path in (archive, Path(str(archive) + '.sig'), dmg)):
        raise RuntimeError('Release assets already exist; use a fresh output directory.')
    sign_runtime(app)
    verify_bundle(app)
    # Python tarfile does not insert Apple's resource-fork sidecar entries.
    with tarfile.open(archive, 'w:gz') as tar:
        tar.add(app, arcname='Silo.app')
    with tarfile.open(archive, 'r:gz') as tar:
        if any(member.name.split('/')[0] != 'Silo.app' for member in tar):
            raise RuntimeError('The update archive must contain only Silo.app.')
    signer = ['npx', 'tauri', 'signer', 'sign', '-p',
              os.environ.get('TAURI_SIGNING_PRIVATE_KEY_PASSWORD', '')]
    try:
        is_file = Path(key).is_file()
    except OSError:
        is_file = False
    if is_file:
        signer += ['-f', key]
    # For key contents, Tauri reads the private key from its environment.
    subprocess.run(signer + [str(archive)], check=True, stdout=subprocess.DEVNULL)
    with tempfile.TemporaryDirectory(prefix='silo-dmg-') as temporary:
        stage = Path(temporary) / 'image'
        stage.mkdir()
        subprocess.run(['ditto', str(app), str(stage / 'Silo.app')], check=True)
        (stage / 'Applications').symlink_to('/Applications')
        subprocess.run(['hdiutil', 'create', '-volname', 'Silo', '-srcfolder', str(stage),
                        '-format', 'UDZO', str(dmg)], check=True)
    print(f'Created verified release assets in {output}')


if __name__ == '__main__':
    main()
