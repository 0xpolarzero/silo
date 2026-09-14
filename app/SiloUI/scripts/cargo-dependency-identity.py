"""Candidate semantic inputs; not wired into the running cache experiment.

Normalize only the excluded root application's version. Preserve all other
manifest/config fields, lock pins, graph edges, features, and non-root IDs.
Callers must also retain the existing compiler, SDK, environment, and path key.
"""
import copy
import hashlib
import json

ROOT_MARKER = 'excluded-application-root'


def semantic_resolution(metadata, lock):
    """Normalize only root version metadata in the current lock and graph."""
    root_id = metadata['resolve']['root']
    roots = [p for p in metadata['packages'] if p['id'] == root_id]
    if len(roots) != 1 or roots[0].get('source') is not None:
        raise ValueError('expected one local application root')
    root = roots[0]
    if root_id not in metadata['workspace_members']:
        raise ValueError('application root must be a workspace member')
    normalized_lock = copy.deepcopy(lock)
    pins = [p for p in normalized_lock['package'] if p.get('source') is None
            and (p['name'], p['version']) == (root['name'], root['version'])]
    if len(pins) != 1:
        raise ValueError('expected one exact local application lock entry')
    pins[0]['version'] = ROOT_MARKER
    def normalize_ids(value):
        if isinstance(value, str):
            return ROOT_MARKER if value == root_id else value
        if isinstance(value, list):
            return [normalize_ids(item) for item in value]
        if isinstance(value, dict):
            return {key: normalize_ids(item) for key, item in value.items()}
        return value

    graph = normalize_ids(metadata['resolve']['nodes'])
    return {'lock': normalized_lock, 'graph': sorted(graph, key=lambda node: node['id'])}


def semantic_inputs(metadata, lock, manifest, tauri, build_context):
    """Return public canonical inputs without changing caller-owned values."""
    resolution = semantic_resolution(metadata, lock)
    root = next(p for p in metadata['packages'] if p['id'] == metadata['resolve']['root'])
    if (manifest['package']['name'], manifest['package']['version']) != (root['name'], root['version']):
        raise ValueError('application manifest does not match resolved root')
    normalized_manifest = copy.deepcopy(manifest)
    normalized_manifest['package']['version'] = ROOT_MARKER
    normalized_tauri = copy.deepcopy(tauri)
    if 'version' in normalized_tauri:
        normalized_tauri['version'] = ROOT_MARKER
    return {'schemaVersion': 1, **resolution,
            'manifest': normalized_manifest, 'tauri': normalized_tauri,
            'buildContext': copy.deepcopy(build_context)}


def identity_digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
