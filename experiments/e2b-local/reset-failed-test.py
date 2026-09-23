"""Explicitly remove a failed run's tagged desktops; retain its evidence."""
import argparse
import json

import httpx
from qualification import run_directory


def target_ids(report, desktops, run_id):
    if report.get('run_id') != run_id or report.get('status') != 'failed':
        raise ValueError('Cleanup requires the exact failed qualification run')
    recorded = report.get('desktops', [])
    if len(recorded) != len(set(recorded)):
        raise ValueError('Run has duplicate recorded desktops')
    by_id = {item['id']: item for item in desktops}
    for sid in recorded:
        item = by_id.get(sid)
        if item is None or item.get('run_id') != run_id:
            raise ValueError(f'Refusing cleanup of desktop without this run tag: {sid}')
    # The registry is authoritative when create was accepted but its HTTP
    # response was lost before qualification.py could journal the ID.
    owned = [item['id'] for item in desktops if item.get('run_id') == run_id]
    if not owned:
        raise ValueError('Run has no tagged desktops to clean up')
    return [sid for sid in owned if by_id[sid]['status'] != 'deleted']


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-id', required=True)
    args = parser.parse_args(argv)
    directory = run_directory(args.run_id)
    report = json.loads((directory / 'qualification.json').read_text())
    with httpx.Client(base_url='http://127.0.0.1:3800', timeout=60,
                      headers={'X-Poc-Request': '1'}, trust_env=False) as client:
        state = client.get('/api/state').raise_for_status().json()
        # Validate the whole set before deleting any desktop.
        targets = target_ids(report, state['desktops'], args.run_id)
        for sid in targets:
            client.post(f'/api/desktops/{sid}/lifecycle', json={'action': 'delete'}).raise_for_status()
            print('Removed failed-run desktop', sid, flush=True)


if __name__ == '__main__':
    main()
