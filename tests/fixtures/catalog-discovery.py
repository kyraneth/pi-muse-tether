#!/usr/bin/env python3
"""Offline MSP discovery fixture. Never delegates to an official client or model."""
import json, os, sys
with open(os.environ['CATALOG_ENTRY_CALLS'], 'a') as log:
    log.write(json.dumps({'argv': sys.argv[1:]}) + '\n')
if sys.argv[1:] == ['--version']:
    print('Muse Code 1.4.14 (1.4.14-R7309.1)')
    raise SystemExit(0)
if not sys.argv[1:] or sys.argv[1] != 'serve':
    raise SystemExit('Offline discovery fixture refuses non-serve command')
for line in sys.stdin:
    request = json.loads(line)
    method = request.get('method')
    with open(os.environ['CATALOG_ENTRY_CALLS'], 'a') as log:
        log.write(json.dumps({'method': method}) + '\n')
    if method == 'initialized':
        continue
    if method == 'initialize':
        result = {'serverInfo': {'name': 'offline-catalog-fixture', 'version': '1.4.14'},
                  'sessionDurability': 'ephemeral', 'grantedCapabilities': ['sessionMcp'],
                  'schema': {'version': 1, 'fingerprint': 'sha256:c94c3d1f2f51e6424074b9ec43eac3eedcf532d3dcd77351ec1383a87d3049c6'}}
    elif method == 'model/list':
        with open(os.environ['CATALOG_ENTRY_FIXTURE']) as fixture:
            result = json.load(fixture)
        if os.environ.get('CATALOG_ENTRY_REQUIRE_VENDOR_SEED') == '1' and not result.get('offlineFailure'):
            # Model the official client's bundled response when its saved provider
            # catalogue is not visible in the child data root.
            seed = os.path.join(os.environ['XDG_DATA_HOME'], 'muse/model-catalog/6d657461__p66697874757265.json')
            try:
                with open(seed) as cache:
                    seeded = json.load(cache) == result
            except FileNotFoundError:
                seeded = False
            if not seeded:
                result = {**result, 'source': 'bundledCatalog', 'models': []}
        if result.get('offlineFailure'):
            print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'error': {'code': -32000, 'message': 'synthetic discovery failure'}}), flush=True)
            continue
    else:
        raise SystemExit('Offline discovery fixture refuses ' + str(method))
    print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}), flush=True)
