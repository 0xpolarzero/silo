"""Read channel.rs through Rust itself; no Tauri build or credentials are needed."""
from functools import cache
import json
from pathlib import Path
import subprocess
import tempfile


SOURCE = Path(__file__).with_suffix('.rs')


@cache
def channel_names(source=SOURCE):
    with tempfile.TemporaryDirectory(prefix='silo-channel-names-') as temporary:
        binary = Path(temporary) / 'channel-names'
        subprocess.run(['rustc', '--edition=2021', str(source), '-o', str(binary)],
                       check=True, capture_output=True, text=True)
        result = subprocess.run([str(binary)], check=True, capture_output=True, text=True)
        return json.loads(result.stdout)


def channel_for_identifier(identifier):
    names = channel_names()
    return names['production' if identifier == names['production']['identifier'] else 'development']


if __name__ == '__main__':
    print(json.dumps(channel_names()))
