"""Compare LCU guest memory and files across a clean outer-host shutdown."""
import argparse
import json
from pathlib import Path
import uuid
import qualification as q

def capture(ids):
    return {'host_boot_id': Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
            'source_memory': q.shell(ids[0], 'curl -fsS http://127.0.0.1:8788'),
            'source_file': q.shell(ids[0], 'cat /home/user/checkpoint.txt'),
            'second_file_hash': q.shell(ids[1], 'sha256sum /home/user/host-restart-canary.txt')}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('capture', 'verify'))
    parser.add_argument('--run-id', required=True)
    args = parser.parse_args(argv)
    q.configure()
    q.EVIDENCE = q.run_directory(args.run_id)
    q.PATH = q.EVIDENCE / 'qualification.json'
    report = json.loads(q.PATH.read_text())
    if report.get('run_id') != args.run_id or report.get('status') != 'passed':
        raise RuntimeError('Host restart probe requires a passing report from this run')
    ids = report['desktops'][:2]
    current = {item['id']: item for item in q.api('state')['desktops']}
    if len(ids) != 2 or any(current.get(sid, {}).get('run_id') != args.run_id for sid in ids):
        raise RuntimeError('Host restart probe requires two desktops tagged to this run')
    path = q.EVIDENCE / 'lcu-host-restart.json'
    if args.action == 'capture':
        if path.exists():
            raise RuntimeError('Host restart capture already exists for this run')
        q.api(f'desktops/{ids[1]}/agent/write', {'path': 'host-restart-canary.txt', 'content': str(uuid.uuid4())})
        path.write_text(json.dumps({'run_id': args.run_id, 'before': capture(ids)}, indent=2))
        print('Captured process memory and files before host shutdown')
    else:
        result = json.loads(path.read_text())
        if result.get('run_id') != args.run_id or 'after' in result:
            raise RuntimeError('Host restart capture is missing, mismatched, or already verified')
        for sid in ids:
            q.api(f'desktops/{sid}/lifecycle', {'action': 'resume'})
        result['after'] = q.wait(lambda: capture(ids), timeout=60)
        assert result['before']['host_boot_id'] != result['after']['host_boot_id']
        for key in ('source_memory', 'source_file', 'second_file_hash'):
            assert result['before'][key] == result['after'][key], key
        q.js(ids[0], 'await cua.getState();')
        assert 'Silo LCU Target' in q.text(q.js(ids[0], 'await cua.listWindows();'))
        result.update(status='passed', LCU_reconnected=True)
        path.write_text(json.dumps(result, indent=2))
        print('PASS: LCU, memory and files recovered across a complete host restart')


if __name__ == '__main__':
    main()
