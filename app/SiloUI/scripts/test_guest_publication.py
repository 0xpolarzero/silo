"""Guest publication preflight against recorded HTTP outcomes, with no network."""
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError, URLError


SCRIPT = Path(__file__).with_name('check-guest-publication.py')
spec = importlib.util.spec_from_file_location('guest_publication', SCRIPT)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class Response(io.BytesIO):
    def __init__(self, body):
        super().__init__(json.dumps(body).encode())
        self.status = 200


def error(status, body):
    return HTTPError('https://example.invalid', status, 'fixture', {},
                     io.BytesIO(json.dumps(body).encode()))


MISSING_RELEASE = {'message': 'Not Found'}
MISSING_MANIFEST = {'errors': [{'code': 'MANIFEST_UNKNOWN'}]}


class GuestPublicationTests(unittest.TestCase):
    def check(self, responses):
        opener = Mock()
        opener.open.side_effect = responses
        with patch.object(guard, 'build_opener', return_value=opener):
            guard.check('owner/silo', 'guest-v5', 'ghcr.io/owner/silo-guest:v5',
                        'publisher', 'synthetic-job-token')
        return opener.open.call_args_list

    def test_only_confirmed_missing_release_and_manifests_allow_publication(self):
        calls = self.check([error(404, MISSING_RELEASE), Response({'token': 'registry-token'}),
                            error(404, MISSING_MANIFEST), error(404, MISSING_MANIFEST), error(404, MISSING_MANIFEST)])
        requests = [call.args[0] for call in calls]
        self.assertEqual(requests[0].full_url, 'https://api.github.com/repos/owner/silo/releases/tags/guest-v5')
        self.assertEqual([request.full_url for request in requests[2:]], [
            'https://ghcr.io/v2/owner/silo-guest/manifests/v5-arm64',
            'https://ghcr.io/v2/owner/silo-guest/manifests/v5-amd64',
            'https://ghcr.io/v2/owner/silo-guest/manifests/v5'])
        self.assertEqual(requests[2].get_header('Authorization'), 'Bearer registry-token')

    def test_existing_release_stops_before_registry_access(self):
        with self.assertRaisesRegex(ValueError, 'release already exists'):
            self.check([Response({'tag_name': 'guest-v5'})])

    def test_first_publication_allows_confirmed_missing_repository(self):
        missing = {'errors': [{'code': 'NAME_UNKNOWN'}]}
        self.check([error(404, MISSING_RELEASE), Response({'token': 'registry-token'}),
                    error(404, missing), error(404, missing), error(404, missing)])

    def test_credentials_are_never_redirected(self):
        self.assertIsNone(guard.NoRedirect().redirect_request(
            None, None, 302, 'redirect', {}, 'https://example.invalid'))
        with self.assertRaises(ValueError):
            self.check([error(302, {})])

    def test_existing_architecture_stops_partial_publication_retry(self):
        for responses in [[Response({})], [error(404, MISSING_MANIFEST), Response({})]]:
            with self.subTest(architecture=len(responses)), self.assertRaisesRegex(ValueError, 'image already exists'):
                self.check([error(404, MISSING_RELEASE), Response({'token': 'registry-token'}), *responses])

    def test_existing_multi_architecture_tag_stops_overwrite(self):
        with self.assertRaisesRegex(ValueError, 'image already exists'):
            self.check([error(404, MISSING_RELEASE), Response({'token': 'registry-token'}),
                        error(404, MISSING_MANIFEST), error(404, MISSING_MANIFEST), Response({})])

    def test_lookup_errors_never_authorize_publication(self):
        for status in (401, 403, 429, 500, 503):
            for phase in ('release', 'token', 'manifest'):
                with self.subTest(status=status, phase=phase), self.assertRaises(ValueError):
                    prefix = [] if phase == 'release' else [error(404, MISSING_RELEASE)]
                    if phase == 'manifest':
                        prefix.append(Response({'token': 'registry-token'}))
                    self.check([*prefix, error(status, MISSING_MANIFEST)])

    def test_multi_architecture_lookup_errors_stop_publication(self):
        for status in (401, 403, 429, 500, 503):
            with self.subTest(status=status), self.assertRaises(ValueError):
                self.check([error(404, MISSING_RELEASE), Response({'token': 'registry-token'}),
                            error(404, MISSING_MANIFEST), error(404, MISSING_MANIFEST),
                            error(status, MISSING_MANIFEST)])

    def test_unclassified_404_and_transport_errors_stop(self):
        for outcome in (error(404, {}), error(404, {'errors': [{'code': 'UNAUTHORIZED'}]}),
                        error(404, {'errors': [{'code': 'MANIFEST_UNKNOWN'}, {'code': 'DENIED'}]}),
                        URLError('synthetic-job-token'), TimeoutError('synthetic-job-token')):
            with self.subTest(outcome=type(outcome).__name__), self.assertRaises(ValueError) as raised:
                self.check([error(404, MISSING_RELEASE), Response({'token': 'registry-token'}), outcome])
            self.assertNotIn('synthetic-job-token', str(raised.exception))

    def test_missing_registry_token_and_invalid_json_stop(self):
        with self.assertRaises(ValueError):
            self.check([error(404, MISSING_RELEASE), Response({})])
        response = Response({})
        response.seek(0)
        response.truncate()
        response.write(b'not JSON')
        response.seek(0)
        with self.assertRaises(ValueError):
            self.check([response])

    def test_workflow_runs_preflight_before_build_and_push(self):
        workflow = (SCRIPT.parents[3] / '.github/workflows/guest-image.yml').read_text()
        command = 'python3 app/SiloUI/scripts/check-guest-publication.py'
        self.assertLess(workflow.index(command), workflow.index('node app/SiloUI/scripts/build-guest-image.mjs arm64'))
        self.assertLess(workflow.index(command), workflow.index('docker push'))

    def test_publication_queue_keeps_multiple_pending_versions(self):
        workflow = (SCRIPT.parents[3] / '.github/workflows/guest-image.yml').read_text()
        concurrency = workflow.split('\nconcurrency:\n', 1)[1].split('\njobs:', 1)[0]
        self.assertIn('  queue: max', concurrency.splitlines())
        self.assertIn('  cancel-in-progress: false', concurrency.splitlines())


if __name__ == '__main__':
    unittest.main()
