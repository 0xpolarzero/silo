"""Gate C: real GitHub provider qualification for the Silo E2B PoC.

Exercises the real provider with the already-authenticated gh credential
against one disposable private repository only (default
0xpolarzero/silo-e2b-provider-qualification): git smart-HTTP clone/push with
byte fidelity, Git LFS upload/download, gh REST and GraphQL, token scope
introspection, and denied controls against repositories we do not own and a
nonexistent repository. Writes a JSON report; each run uses a fresh temporary
workdir and pushes only to qualification/run-<short-uuid> branches.

Safety rules encoded here: the credential value is never printed, logged, or
written anywhere. It reaches git only through the gh credential helper
(`gh auth git-credential`), never argv, config files, or URLs; the report
carries only its SHA-256 digest. Outbound HTTPS is routed through a local
CONNECT-tunnel recorder that records destination host:port only; no request
header or body is ever captured. GIT_TRACE and GIT_CURL_VERBOSE are never set
because they can log authorization headers.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO_DEFAULT = '0xpolarzero/silo-e2b-provider-qualification'
RUN = uuid.uuid4().hex[:8]
BRANCH = f'qualification/run-{RUN}'
DENY_BRANCH = f'silo-qualification-deny-{RUN}'
DENY_FILE = f'{DENY_BRANCH}.md'
NOT_EXISTING = f'0xpolarzero/silo-e2b-provider-qualification-absent-{RUN}'
TOKEN_LIKE = re.compile(r'gh[a-z]_[A-Za-z0-9_]{16,}')
URL_USERINFO = re.compile(r'https?://[^\s/@]+@')
HTTP_STATUS = re.compile(r'(?:requested URL returned error: |HTTP )(\d{3})')

TOKEN = None
DIGEST = None
REPO = None
GH = shutil.which('gh') or 'gh'
RECORDER = None
PROXY_URL = None
ACTIVE = None
REPORT = {'status': 'running', 'cases': []}
NOT_COVERED = [
    'Revocation-after-restore with a real rotated token requires a second live '
    'GitHub credential that does not exist; blocked (only one account token available).',
    'Absence of credentials on presigned LFS object-storage hosts (githubusercontent.com and '
    'S3 amazonaws.com) is established by the documented presigned flow plus the successful presigned '
    'S3 upload (AWS rejects presigned requests that also carry an Authorization header); no MITM TLS '
    'interception was performed, by policy.',
    'Only the gh OAuth token (gho_) was qualified. Fine-grained PATs, classic PATs '
    'and GitHub App child tokens are untested here.',
    'Token rotation and revocation were not exercised: they would invalidate the '
    "user's live gh session.",
    'SSH git transport, commit signing, uploads.github.com release assets, packages, '
    'and registry hosts were not contacted.',
    'GraphQL ran against real GitHub only to characterize what real workflows need; '
    'the PoC broker still rejects GraphQL at the authorization layer. That product '
    'gap is documented, not solved here.',
    'Single account, single host machine, sequential operations: no cross-account, '
    'concurrent-session, or rate-limit-exhaustion behavior.',
]


def redact(text):
    if TOKEN:
        text = text.replace(TOKEN, '<credential-redacted>')
    return URL_USERINFO.sub('https://<credential-redacted>@', TOKEN_LIKE.sub('<credential-redacted>', text))


def tail(text, limit=3000):
    text = redact(text or '')
    return text if len(text) <= limit else '...' + text[-limit:]


def base_env(net):
    env = dict(os.environ)
    env.update(GIT_TERMINAL_PROMPT='0', GIT_ASKPASS='/usr/bin/true', GH_PROMPT_DISABLED='1')
    for key in ('HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'):
        if net and PROXY_URL:
            env[key] = PROXY_URL
        else:
            env.pop(key, None)
    if net and PROXY_URL:
        env.update(NO_PROXY='', no_proxy='')
    return env


def run(argv, cwd=None, net=True, check=True, timeout=600, record=True):
    completed = subprocess.run(argv, cwd=None if cwd is None else str(cwd), env=base_env(net),
        capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=timeout)
    if record:
        entry = {'argv': [redact(part) for part in argv], 'code': completed.returncode}
        if completed.returncode != 0:
            entry['stderr_tail'] = tail(completed.stderr, 1200)
        (ACTIVE if ACTIVE is not None else REPORT).setdefault('commands', []).append(entry)
    if check and completed.returncode != 0:
        raise RuntimeError(f'{argv[:3]} exited {completed.returncode}: {tail(completed.stderr, 600)}')
    return completed


def git(repo, *args, **kwargs):
    return run(['git', '-C', str(repo), *args], **kwargs)


def phase(name):
    if RECORDER is not None:
        RECORDER.phase = name


def token_digest():
    global TOKEN, DIGEST
    completed = subprocess.run(['gh', 'auth', 'token'], capture_output=True, text=True)
    TOKEN = completed.stdout.strip()
    if not TOKEN:
        raise RuntimeError('gh is not authenticated; run gh auth status')
    DIGEST = hashlib.sha256(TOKEN.encode()).hexdigest()


def credential_for(repo, host):
    """Digest only: git credential fill output is parsed in memory, never stored."""
    completed = subprocess.run(['git', '-C', str(repo), 'credential', 'fill'],
        input=f'protocol=https\nhost={host}\n\n', capture_output=True, text=True,
        env=base_env(True), timeout=120)
    fields = dict(line.split('=', 1) for line in completed.stdout.splitlines() if '=' in line)
    password = fields.get('password', '')
    return {'username': fields.get('username'),
            'password_sha256': hashlib.sha256(password.encode()).hexdigest() if password else None}


class Recorder(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        self.entries = []
        self.lock = threading.Lock()
        self.phase = 'startup'
        super().__init__(('127.0.0.1', 0), Tunnel)

    def record(self, target):
        host, _, port = target.rpartition(':')
        with self.lock:
            self.entries.append({'t': round(time.time(), 3), 'phase': self.phase,
                                 'host': host, 'port': port})


def pump(source, destination):
    source.settimeout(900)
    destination.settimeout(900)
    try:
        while True:
            data = source.recv(65536)
            if not data:
                break
            destination.sendall(data)
    except OSError:
        pass
    finally:
        try:
            destination.shutdown(socket.SHUT_WR)
        except OSError:
            pass


class Tunnel(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def do_CONNECT(self):
        self.server.record(self.path)
        host, _, port = self.path.rpartition(':')
        try:
            upstream = socket.create_connection((host, int(port)), timeout=30)
        except OSError:
            self.connection.sendall(b'HTTP/1.1 502 Bad Gateway\r\n\r\n')
            self.close_connection = True
            return
        self.connection.sendall(b'HTTP/1.1 200 Connection Established\r\n\r\n')
        self.close_connection = True
        relay = threading.Thread(target=pump, args=(self.connection, upstream), daemon=True)
        relay.start()
        pump(upstream, self.connection)
        relay.join()
        upstream.close()

    def do_GET(self):
        self.send_error(405, 'CONNECT proxy only')


def phase_hosts():
    with RECORDER.lock:
        entries = list(RECORDER.entries)
    phases = {}
    for entry in entries:
        hosts = phases.setdefault(entry['phase'], {})
        hosts[entry['host']] = hosts.get(entry['host'], 0) + 1
    return phases


def case_a(workdir, url):
    phase('a-clone-empty-repo')
    clone = run(['git', 'clone', url, 'work'], cwd=workdir, timeout=300)
    repo = workdir / 'work'
    git(repo, 'symbolic-ref', 'HEAD', f'refs/heads/{BRANCH}')
    git(repo, 'read-tree', '--empty')  # reruns on a non-empty repo: start from an empty index
    for key, value in (('user.name', 'Silo Qualification'),
                       ('user.email', 'silo-qualification@example.local'),
                       ('core.autocrlf', 'false'),
                       ('credential.helper', ''),
                       ('credential.https://github.com.helper', ''),
                       ('credential.https://github.com.helper', f'!{GH} auth git-credential')):
        run(['git', 'config', '--local', key, value], cwd=repo)
    identity = {key: run(['git', 'config', '--get', key], cwd=repo, record=False).stdout.strip()
                for key in ('user.name', 'user.email')}
    helpers = git(repo, 'config', '--show-origin', '--get-all', 'credential.https://github.com.helper',
                  record=False).stdout.strip()
    fill = credential_for(repo, 'github.com')
    evidence = {
        'empty_repo_clone_warning': 'empty repository' in clone.stderr,
        'clone_stderr_tail': tail(clone.stderr, 400),
        'note_first_run': 'the target repo starts empty; reruns clone the previous qualification branches',
        'identity': identity,
        'repo_local_helper_chain': tail(helpers, 600),
        'git_credential_username': fill['username'],
        'git_credential_password_sha256': fill['password_sha256'],
        'git_credential_digest_matches_gh_token': fill['password_sha256'] == DIGEST,
        'note': 'local config resets inherited helpers (credential.helper store, global gh entry) '
                'and pins github.com to gh auth git-credential only',
    }
    assert identity == {'user.name': 'Silo Qualification', 'user.email': 'silo-qualification@example.local'}
    assert fill['password_sha256'] == DIGEST, 'git credential fill digest differs from gh token'
    return evidence


def case_b(repo):
    phase('b-unicode-commit-push')
    content = ('Silo E2B PoC Gate C — real provider qualification 🧪\n'
               f'run {RUN} branch {BRANCH}\n'
               'CJK: 沙盒凭证资格 · 日本語テスト · 한국어\n'
               'RTL: اختبار بيانات الاعتماد\n'
               'combining: çömbined é accents á and ﬁ ligature Æ\n').encode('utf-8')
    (repo / 'unicode.md').write_bytes(content)
    git(repo, 'add', 'unicode.md')
    git(repo, 'commit', '-m', f'Silo Gate C Unicode qualification {RUN}')
    git(repo, 'push', '-u', 'origin', f'refs/heads/{BRANCH}', timeout=300)
    sha = git(repo, 'rev-parse', 'HEAD', record=False).stdout.strip()
    phase('b-verify-server-api')
    commit = json.loads(run(['gh', 'api', f'/repos/{REPO}/commits/{sha}'], timeout=120).stdout)
    listing = json.loads(run(['gh', 'api', f'/repos/{REPO}/contents/unicode.md?ref={BRANCH}'], timeout=120).stdout)
    remote = base64.b64decode(listing['content'].replace('\n', ''))
    evidence = {
        'pushed_sha': sha,
        'api_commit_sha': commit.get('sha'),
        'api_commit_matches': commit.get('sha') == sha,
        'api_commit_author': f"{commit['commit']['author']['name']} <{commit['commit']['author']['email']}>",
        'local_bytes': len(content),
        'local_sha256': hashlib.sha256(content).hexdigest(),
        'api_file_sha256': hashlib.sha256(remote).hexdigest(),
        'api_bytes_identical': remote == content,
    }
    assert evidence['api_commit_matches'], 'commit not found server-side'
    assert remote == content, 'server file content differs from local bytes'
    assert evidence['api_commit_author'] == 'Silo Qualification <silo-qualification@example.local>'
    return sha, evidence


def case_c(workdir, url, repo):
    phase('c-second-clone')
    run(['git', 'clone', '--branch', BRANCH, '--single-branch', url, 'second'], cwd=workdir, timeout=300)
    second = workdir / 'second'
    first_index = git(repo, 'ls-files', '-s', record=False).stdout
    second_index = git(second, 'ls-files', '-s', record=False).stdout
    first_head = git(repo, 'rev-parse', 'HEAD', record=False).stdout.strip()
    second_head = git(second, 'rev-parse', 'HEAD', record=False).stdout.strip()
    files = git(repo, 'ls-files', record=False).stdout.split()
    identical = {name: (repo / name).read_bytes() == (second / name).read_bytes() for name in files}
    evidence = {
        'index_entries_identical': first_index == second_index,
        'head_identical': first_head == second_head,
        'head_sha': first_head,
        'tracked_files': sorted(files),
        'bytes_identical_per_file': identical,
    }
    assert first_index == second_index and first_head == second_head, 'clone index or head differs'
    assert all(identical.values()), 'file bytes differ after smart-HTTP fetch'
    return evidence


def case_d(workdir, repo, url):
    phase('d-lfs-track-commit-push')
    git(repo, 'lfs', 'install', '--local')
    git(repo, 'lfs', 'track', '*.bin')
    blob = os.urandom(2 * 1024 * 1024)
    expected = hashlib.sha256(blob).hexdigest()
    (repo / 'large.bin').write_bytes(blob)
    git(repo, 'add', '.gitattributes', 'large.bin')
    git(repo, 'commit', '-m', f'Silo Gate C LFS qualification {RUN}')
    git(repo, 'push', 'origin', f'refs/heads/{BRANCH}', timeout=600)
    pointer_sha = git(repo, 'rev-parse', 'HEAD', record=False).stdout.strip()
    phase('d-verify-server-api')
    listing = json.loads(run(['gh', 'api', f'/repos/{REPO}/contents/large.bin?ref={BRANCH}'], timeout=120).stdout)
    pointer = base64.b64decode(listing['content'].replace('\n', '')).decode()
    pointer_oid = next(line.split('sha256:')[1] for line in pointer.splitlines() if line.startswith('oid '))
    directory = json.loads(run(['gh', 'api', f'/repos/{REPO}/contents/?ref={BRANCH}'], timeout=120).stdout)
    objects_endpoint = run(['gh', 'api', f'/repos/{REPO}/git/lfs/objects'], check=False, timeout=120)
    objects_status = HTTP_STATUS.search(objects_endpoint.stderr or '') or HTTP_STATUS.search(objects_endpoint.stdout or '')
    phase('d-fresh-clone-re-download')
    run(['git', 'clone', '--branch', BRANCH, '--single-branch', url, 'lfs-clone'], cwd=workdir, timeout=600)
    clone = workdir / 'lfs-clone'
    checkout_bytes = (clone / 'large.bin').stat().st_size
    git(clone, 'lfs', 'install', '--local')
    git(clone, 'lfs', 'pull', timeout=600)
    downloaded = hashlib.sha256((clone / 'large.bin').read_bytes()).hexdigest()
    ls_files = git(clone, 'lfs', 'ls-files', '-l', record=False).stdout
    lfs_raw = git(clone, 'lfs', 'env', record=False).stdout
    endpoint = next((line.split('=', 1)[1].split()[0] for line in lfs_raw.splitlines()
                     if line.startswith('Endpoint=')), None)
    lfs_env = tail('\n'.join(line for line in lfs_raw.splitlines()
                             if line.startswith(('Endpoint', 'Access', 'DownloadTransfers',
                                                 'UploadTransfers', 'git-lfs/'))), 1500)
    evidence = {
        'pointer_commit_sha': pointer_sha,
        'local_object_sha256': expected,
        'server_pointer_oid': pointer_oid,
        'server_pointer_matches': pointer_oid == expected,
        'server_directory_listing': [{'name': item['name'], 'size': item['size']} for item in directory],
        'git_lfs_objects_endpoint_status': objects_status.group(1) if objects_status else None,
        'git_lfs_objects_endpoint_note': 'no public REST listing for LFS objects; contents pointer + '
                                         'end-to-end re-download are the existence proof',
        'clone_checkout_bytes_before_pull': checkout_bytes,
        'clone_download_sha256': downloaded,
        'lfs_roundtrip_sha256_matches': downloaded == expected,
        'clone_lfs_ls_files': tail(ls_files, 300),
        'git_lfs_env': lfs_env,
        'lfs_endpoint': endpoint,
    }
    assert pointer_oid == expected, 'server LFS pointer oid differs'
    assert downloaded == expected, 're-downloaded object sha256 differs'
    assert expected in ls_files, 'lfs ls-files does not show the expected oid'
    return evidence


def case_e():
    phase('e-rest-read')
    data = json.loads(run(['gh', 'api', f'/repos/{REPO}'], timeout=120).stdout)
    evidence = {key: data.get(key) for key in
                ('full_name', 'private', 'visibility', 'default_branch', 'pushed_at', 'permissions')}
    evidence['is_expected_repo'] = data.get('full_name') == REPO
    assert evidence['is_expected_repo'] and data.get('private') is True
    return evidence


def case_f():
    phase('f-graphql')
    result = json.loads(run(['gh', 'api', 'graphql', '-f', 'query={ viewer { login } }'], timeout=120).stdout)
    login = result['data']['viewer']['login']
    evidence = {
        'query': '{ viewer { login } }',
        'login': login,
        'succeeded': True,
        'note': 'PoC broker currently rejects GraphQL; recorded to characterize what real '
                'workflows need from a future provider-authorized GraphQL policy',
    }
    assert login == REPO.split('/')[0]
    return evidence


def case_g(repo):
    phase('g-deny-push-octocat')
    push = run(['git', 'push', 'https://github.com/octocat/Hello-World.git',
                f'HEAD:refs/heads/{DENY_BRANCH}'], cwd=repo, check=False, timeout=300)
    push_status = HTTP_STATUS.search(push.stderr or '')
    phase('g-deny-verify-no-branch-created')
    branch = run(['gh', 'api', f'/repos/octocat/Hello-World/branches/{DENY_BRANCH}'],
                 check=False, timeout=120)
    branch_status = HTTP_STATUS.search(branch.stderr or '')
    phase('g-deny-write-octocat')
    body = base64.b64encode(b'Silo Gate C denied write control; no content change intended.\n').decode()
    put = run(['gh', 'api', '--method', 'PUT', f'/repos/octocat/Hello-World/contents/{DENY_FILE}',
               '-f', f'message=Silo Gate C denied write probe {RUN}', '-f', f'content={body}'],
              check=False, timeout=120)
    put_status = HTTP_STATUS.search(put.stderr or '')
    phase('g-nonexistent-repo')
    missing_api = run(['gh', 'api', f'/repos/{NOT_EXISTING}'], check=False, timeout=120)
    missing_api_status = HTTP_STATUS.search(missing_api.stderr or '')
    missing_git = run(['git', 'ls-remote', f'https://github.com/{NOT_EXISTING}.git'],
                      check=False, timeout=120)
    missing_git_status = HTTP_STATUS.search(missing_git.stderr or '')
    evidence = {
        'push_to_foreign_repo': {'denied': push.returncode != 0,
                                 'http_status': push_status.group(1) if push_status else None,
                                 'stderr_tail': tail(push.stderr, 700)},
        'foreign_branch_absent_after_deny': {'status': branch_status.group(1) if branch_status else None,
                                             'absent': branch.returncode != 0},
        'contents_write_to_foreign_repo': {'denied': put.returncode != 0,
                                           'http_status': put_status.group(1) if put_status else None,
                                           'stderr_tail': tail(put.stderr, 700)},
        'nonexistent_repo_api': {'denied': missing_api.returncode != 0,
                                 'http_status': missing_api_status.group(1) if missing_api_status else None},
        'nonexistent_repo_git': {'denied': missing_git.returncode != 0,
                                 'http_status': missing_git_status.group(1) if missing_git_status else None,
                                 'stderr_tail': tail(missing_git.stderr, 400)},
        'note': 'the failing PUT contents call is the whole write attempt; no other '
                'content change against foreign repositories was attempted',
    }
    denied = (push.returncode != 0 and branch.returncode != 0 and put.returncode != 0
              and missing_api.returncode != 0 and missing_git.returncode != 0)
    assert denied, 'a denied control unexpectedly succeeded'
    assert push_status and push_status.group(1) in ('403', '404'), 'unexpected push denial status'
    assert put_status and put_status.group(1).startswith('4'), 'unexpected write denial status'
    assert missing_api_status and missing_api_status.group(1) == '404', 'expected 404 for nonexistent repo'
    return evidence


def case_h(lfs_endpoint):
    phase('h-host-accounting')
    phases = phase_hosts()
    all_hosts = sorted({host for hosts in phases.values() for host in hosts})
    lfs_phases = {name: hosts for name, hosts in phases.items() if name.startswith('d-')}
    lfs_hosts = sorted({host for hosts in lfs_phases.values() for host in hosts})
    object_hosts = sorted(host for host in all_hosts
                          if host.endswith('githubusercontent.com') or host.endswith('amazonaws.com'))
    lfs_api_hosts = sorted(host for host in lfs_hosts if host in ('github.com', 'lfs.github.com', 'api.github.com'))
    credentialed = {
        'github.com': 'git smart HTTP and the LFS batch origin; git credential fill digest equals the '
                      'gh token and every private-repository operation requires it',
        'lfs.github.com': 'LFS batch API reached after redirect from github.com/{repo}.git/info/lfs '
                          '(git lfs env Endpoint auth=basic); private-repo LFS success proves delivery',
        'api.github.com': 'gh REST/GraphQL Bearer; authenticated responses (private repo fields, '
                          'x-oauth-scopes) prove delivery, plus the git-lfs locks-verify call during push',
    }
    evidence = {
        'hosts_contacted_by_phase': phases,
        'all_hosts_contacted': all_hosts,
        'lfs_flow_hosts': lfs_hosts,
        'lfs_api_hosts': lfs_api_hosts,
        'lfs_endpoint_from_git_lfs_env': lfs_endpoint,
        'credentialed_hosts': credentialed,
        'credential_free_hosts': {host: 'presigned LFS object-storage href returned by the batch API; '
                                        'git-lfs sends no Authorization header there by documented flow, and '
                                        'the presigned upload/download succeeded while S3 rejects presigned '
                                        'requests that also carry an Authorization header; not MITM-verified'
                                  for host in object_hosts},
        'api_github_com_in_lfs_phase_note': 'the api.github.com contact inside the LFS push phase is the '
                                            'git-lfs locks-verify API, which is credentialed',
        'method': 'local CONNECT-tunnel recorder logs destination host:port only; no headers or bodies '
                  'captured; GIT_TRACE/GIT_CURL_VERBOSE never set',
    }
    assert 'github.com' in all_hosts and 'api.github.com' in all_hosts, 'expected credentialed hosts not contacted'
    return evidence


def case_i():
    phase('i-token-scope-introspection')
    status = run(['gh', 'auth', 'status'], check=False, timeout=120)
    status_text = status.stdout + status.stderr
    scopes_line = next((line.strip() for line in status_text.splitlines() if 'Token scopes' in line), None)
    masked = next((line.strip() for line in status_text.splitlines() if 'Token:' in line), None)
    rate = run(['gh', 'api', '--include', '/rate_limit'], timeout=120)
    head, _, body = rate.stdout.partition('\n\n')
    headers = {line.split(':', 1)[0].strip().lower(): line.split(':', 1)[1].strip()
               for line in head.splitlines() if ':' in line}
    evidence = {
        'gh_auth_status_exit': status.returncode,
        'active_account_login': next((line.strip() for line in status_text.splitlines() if 'Logged in' in line), None),
        'masked_token_line': masked,
        'token_scopes_from_auth_status': scopes_line,
        'x_oauth_scopes_header': headers.get('x-oauth-scopes'),
        'rate_limit_core': json.loads(body)['resources']['core'],
        'note': 'scopes documented from gh auth status and the x-oauth-scopes response header only; '
                'no token value was printed or stored',
    }
    assert status.returncode == 0 and scopes_line and headers.get('x-oauth-scopes')
    return evidence


def guard(case_id, name, function, *args, **kwargs):
    global ACTIVE
    ACTIVE = {'commands': []}
    entry = {'id': case_id, 'name': name, 'status': 'failed', 'commands': ACTIVE['commands']}
    REPORT['cases'].append(entry)
    started = time.time()
    try:
        entry['evidence'] = function(*args, **kwargs)
        entry['status'] = 'pass'
    except Exception as error:
        entry['error'] = f'{type(error).__name__}: {tail(str(error), 1200)}'
    entry['duration_s'] = round(time.time() - started, 1)
    ACTIVE = None
    return entry['status'] == 'pass'


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', default=REPO_DEFAULT)
    parser.add_argument('--report', required=True, type=Path)
    parser.add_argument('--keep-workdir', action='store_true')
    args = parser.parse_args(argv)
    global REPO
    REPO = args.repo
    token_digest()
    url = f'https://github.com/{REPO}.git'
    versions = {
        'gh': run(['gh', '--version'], net=False, record=False).stdout.splitlines()[0],
        'git': run(['git', '--version'], net=False, record=False).stdout.splitlines()[0],
        'git_lfs': run(['git-lfs', 'version'], net=False, record=False).stdout.splitlines()[0],
    }
    report_path = args.report.expanduser().resolve()
    report_path.parent.mkdir(parents=True, exist_ok=True)
    global RECORDER, PROXY_URL
    RECORDER = Recorder()
    PROXY_URL = f'http://127.0.0.1:{RECORDER.server_address[1]}'
    threading.Thread(target=RECORDER.serve_forever, daemon=True).start()
    workdir = Path(tempfile.mkdtemp(prefix=f'silo-gate-c-{RUN}-'))
    REPORT.update(gate='C-real-provider', started_utc=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                  run_id=RUN, branch=BRANCH, deny_branch=DENY_BRANCH, repo=REPO, repo_url=url,
                  host={'system': platform.system(), 'release': platform.release(), 'machine': platform.machine()},
                  tool_versions=versions,
                  credential={'sha256': DIGEST, 'delivery': 'gh credential helper only (gh auth git-credential); '
                                                           'never argv, config, URL, or log', 'value_disclosed': False},
                  network={'recorder': 'local CONNECT tunnel; records destination host:port only',
                           'listen': f'127.0.0.1:{RECORDER.server_address[1]}',
                           'trace_policy': 'GIT_TRACE and GIT_CURL_VERBOSE never set (authorization-header risk)'},
                  workdir={'path': str(workdir), 'fresh_per_run': True, 'kept': args.keep_workdir},
                  not_covered=NOT_COVERED)
    repo, lfs_endpoint = None, None
    try:
        phase('meta-repo-check')
        meta = json.loads(run(['gh', 'api', f'/repos/{REPO}'], timeout=120).stdout)
        REPORT['repo_state_before'] = {'visibility': meta.get('visibility'), 'private': meta.get('private'),
                                       'open_issues': meta.get('open_issues_count'), 'size_kb': meta.get('size')}
        assert meta.get('full_name') == REPO and meta.get('private') is True, 'target repo is not the expected private repo'

        if guard('a', 'Init/clone empty private repo with pinned credential helper', case_a, workdir, url):
            repo = workdir / 'work'
        sha = None
        if repo is not None:
            def unicode_case():
                return case_b(repo)[1]
            guard('b', 'Unicode commit, push qualification branch, verify via REST', unicode_case)
        if repo is not None:
            guard('c', 'Second smart-HTTP clone, byte-identical tree', case_c, workdir, url, repo)
        if repo is not None:
            def lfs_case():
                nonlocal lfs_endpoint
                evidence = case_d(workdir, repo, url)
                lfs_endpoint = evidence['lfs_endpoint']
                return evidence
            guard('d', 'Git LFS upload, server pointer, fresh-clone re-download SHA-256', lfs_case)
        guard('e', 'gh REST read of the repository', case_e)
        guard('f', 'gh GraphQL viewer query (characterization)', case_f)
        if repo is not None:
            guard('g', 'Denied controls: foreign repo push/write and nonexistent repo', case_g, repo)
        guard('h', 'Host accounting from CONNECT tunnel recorder', case_h,
              lfs_endpoint)
        guard('i', 'Token scope introspection without disclosure', case_i)
    finally:
        REPORT['network']['phase_hosts'] = phase_hosts()
        REPORT['network']['entries'] = list(RECORDER.entries)
        RECORDER.shutdown()
        RECORDER.server_close()
        REPORT['status'] = ('passed' if REPORT['cases'] and all(case['status'] == 'pass' for case in REPORT['cases'])
                            else 'failed')
        REPORT['finished_utc'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        if not args.keep_workdir:
            shutil.rmtree(workdir, ignore_errors=True)
        report_path.write_text(json.dumps(REPORT, indent=2))
    print(json.dumps({'gate': 'C-real-provider', 'run_id': RUN, 'branch': BRANCH,
                      'status': REPORT['status'],
                      'cases': {case['id']: case['status'] for case in REPORT['cases']},
                      'credential_sha256': DIGEST, 'report': str(report_path)}, indent=2))
    return 0 if REPORT['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
