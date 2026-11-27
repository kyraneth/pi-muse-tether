#!/usr/bin/env python3
"""Offline client fixture; no network and no delegated client or credential reads."""
import json
import os
from pathlib import Path
import sys

args = sys.argv[1:]
config = Path(os.environ['XDG_CONFIG_HOME'])
auth = config / 'muse/auth.json'
roots = {key: Path(os.environ[f'XDG_{key.upper()}_HOME']) for key in ('data', 'cache', 'state')}


def record(kind, **fields):
    with open(os.environ['VENDOR_ROOTS_LOG'], 'a') as log:
        log.write(json.dumps(dict(kind=kind, pid=os.getpid(), uid=os.getuid(), **fields)) + '\n')


def materialize(kind):
    try:
        for path in roots.values():
            target = path / 'muse'
            target.mkdir(parents=True, exist_ok=True)
            (target / kind).write_text('fixture')
    except PermissionError:
        record('denied', operation=kind)
        return False
    return True


if args == ['--version']:
    print('Muse Code 1.4.14 (1.4.14-R7309.1)')
    sys.exit(0)

# Only metadata: the fake official client never reads the login body either.
assert auth.is_symlink() and auth.resolve(strict=True) == Path(os.environ['VENDOR_ROOTS_AUTH'])
record(args[0], config=str(config), home=os.environ['HOME'], login=os.readlink(auth),
       roots={key: str(value) for key, value in roots.items()})
if args == ['skills', 'list', '--json']:
    if not materialize('skills') or os.environ.get('VENDOR_ROOTS_FAILURE') == 'skills':
        sys.exit(1)
    if os.environ.get('VENDOR_ROOTS_FAILURE') == 'replaced-login':
        auth.unlink()
        auth.write_text('{}')
        sys.exit(1)
    print(json.dumps({'skills': [{'scope': 'bundled', 'path': 'fixture-skill'}]}))
    sys.exit(0)
assert args[0] == 'serve'


def output(**fields):
    print(json.dumps(dict(jsonrpc='2.0', **fields)), flush=True)


session = 'vendor-roots-session'
for line in sys.stdin:
    request = json.loads(line)
    method, params = request.get('method'), request.get('params', {})
    if method == 'initialized':
        continue
    if method == 'initialize':
        result = {'serverInfo': {'name': 'offline-vendor-roots-fixture', 'version': '1.4.14'},
                  'sessionDurability': 'ephemeral', 'grantedCapabilities': ['sessionMcp'],
                  'schema': {'version': 1, 'fingerprint': 'sha256:c94c3d1f2f51e6424074b9ec43eac3eedcf532d3dcd77351ec1383a87d3049c6'}}
    elif method == 'model/list':
        writable = materialize('catalog')
        # Let a seeded catalogue through in the host-only regression case, so a
        # discovery failure cannot mask the independent skills-list failure.
        official = writable or os.environ.get('VENDOR_ROOTS_SEED_CATALOG') == '1'
        result = {'source': 'providerCatalog' if official else 'bundledCatalog', 'models': []}
        if official:
            result.update(providerId='meta', profileId='fixture-profile', models=[{
                'modelId': 'muse-ember-1.0', 'displayLabel': 'Fixture Ember',
                'contextLimit': 200704, 'outputLimit': 32000, 'providerId': 'meta',
                'profileId': 'fixture-profile', 'defaultReasoningEffort': 'high', 'variants': ['minimal', 'high']}])
        record('catalog', source=result['source'])
        if os.environ.get('VENDOR_ROOTS_FAILURE') == 'catalog':
            output(id=request['id'], error={'code': -32000, 'message': 'synthetic catalogue failure'})
            continue
    elif method == 'session/start':
        settings = json.loads((config / 'muse/settings.json').read_text())
        assert settings['skills']['activation'] == {'bundled': {'fixture-skill': 'off'}}
        assert settings['run']['toolset'] == []
        assert params['workspaceRoot'] == str(config.parent / 'workspace')
        assert all((path / 'muse/skills').is_file() for path in roots.values())
        record('session', model=params['modelId'])
        result = {'session': {'sessionId': session, 'permissionState': {'reviewerAuthority': 'human'}}, 'viewCursor': '0'}
    elif method == 'usage/read':
        result = {'usage': {}}
    elif method == 'turn/start':
        turn = params['commandId']
        record('turn', effort=params['reasoningEffort'], input=params['input'])
        output(id=request['id'], result={'commandId': turn, 'status': 'accepted', 'disposition': 'started', 'startedNewTurn': True, 'turnId': turn})
        frames = [('turn/started', {'commandId': turn}),
                  ('item/completed', {'item': {'itemId': 'answer', 'kind': 'agentMessage', 'text': 'OFFLINE_VENDOR_ROOTS_OK'}}),
                  ('session/tokenUsage', {'totalTokens': 2, 'usage': {'inputTokens': 1, 'outputTokens': 1}}),
                  ('turn/completed', {'terminal': 'completed'})]
        for number, (name, payload) in enumerate(frames, 1):
            cursor = {'id': str(number), 'sequence': number}
            output(method=name, params=dict(payload, sessionId=session, turnId=turn, viewCursor=str(number),
                   sourceRange={'first': cursor, 'last': cursor, 'stream': {'id': session, 'kind': 'session'}}))
        continue
    else:
        raise RuntimeError(f'Offline fixture refuses {method}')
    output(id=request['id'], result=result)
