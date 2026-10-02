"""Refuse guest publication unless the release and both image tags are absent."""
import base64
import json
import os
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request_json(url, headers):
    request = Request(url, headers=headers)
    try:
        response = build_opener(NoRedirect()).open(request, timeout=30)
    except HTTPError as error:
        response = error
    except (URLError, TimeoutError):
        raise ValueError('Publication lookup failed; no write is permitted') from None
    with response:
        try:
            body = json.load(response)
        except (ValueError, URLError, TimeoutError):
            raise ValueError('Invalid publication lookup response; no write is permitted') from None
        return response.code if isinstance(response, HTTPError) else response.status, body


def check(repository, release_tag, image, username, token):
    if not re.fullmatch(r'[\w.-]+/[\w.-]+', repository):
        raise ValueError('Invalid publishing repository')
    owner = repository.split('/')[0].lower()
    prefix = f'ghcr.io/{owner}/silo-guest:'
    if not image.startswith(prefix) or not re.fullmatch(r'[\w.-]+', image[len(prefix):]):
        raise ValueError('Image must belong to the publishing repository owner')
    if not username or not token or not release_tag:
        raise ValueError('Missing publishing identity or release tag')
    status, body = request_json(
        f'https://api.github.com/repos/{repository}/releases/tags/{quote(release_tag, safe="")}',
        {'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json'})
    if status == 200:
        raise ValueError('Guest release already exists; increment the recipe version')
    if status != 404 or not isinstance(body, dict) or body.get('message') != 'Not Found':
        raise ValueError(f'Release lookup failed (HTTP {status}); no write is permitted')

    name = f'{owner}/silo-guest'
    credentials = base64.b64encode(f'{username}:{token}'.encode()).decode()
    status, body = request_json('https://ghcr.io/token?' + urlencode({
        'service': 'ghcr.io', 'scope': f'repository:{name}:pull'}),
        {'Authorization': f'Basic {credentials}'})
    registry_token = body.get('token') if isinstance(body, dict) else None
    if status != 200 or not isinstance(registry_token, str) or not registry_token:
        raise ValueError(f'Registry authentication failed (HTTP {status}); no write is permitted')
    for architecture in ('arm64', 'amd64'):
        tag = f'{image[len(prefix):]}-{architecture}'
        status, body = request_json(f'https://ghcr.io/v2/{name}/manifests/{tag}', {
            'Authorization': f'Bearer {registry_token}',
            'Accept': 'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, '
                      'application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json'})
        if status == 200:
            raise ValueError(f'Guest {architecture} image already exists; recover exact artifacts or increment the version')
        errors = body.get('errors') if isinstance(body, dict) else None
        if status != 404 or not isinstance(errors, list) or not errors or not all(
                isinstance(error, dict) and error.get('code') in ('MANIFEST_UNKNOWN', 'NAME_UNKNOWN') for error in errors):
            raise ValueError(f'Image lookup failed (HTTP {status}); no write is permitted')


if __name__ == '__main__':
    try:
        check(os.environ['GH_REPO'], os.environ['RELEASE_TAG'], os.environ['IMAGE'],
              os.environ['GITHUB_ACTOR'], os.environ['GH_TOKEN'])
    except (KeyError, ValueError) as error:
        print(f'::error::{error}', file=sys.stderr)
        sys.exit(1)
