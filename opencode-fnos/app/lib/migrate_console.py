"""Preserve the fnOS V1 Console bridge credentials through the official V2 API."""
import base64
import hashlib
import http.client
import json
import os
from pathlib import Path


def migrate(port, password, etc, data):
    source = Path(data) / 'opencode/auth.json'
    marker = Path(etc) / 'fnos-console-v2-migration.json'
    if marker.exists() or not source.is_file():
        return
    legacy = json.loads(source.read_text('utf-8'))
    if not isinstance(legacy, dict):
        raise ValueError('Legacy credential file must be an object')
    candidates = [(key, legacy.get(key)) for key in ('opencode', 'opencode-go')]
    candidates = [(key, value) for key, value in candidates if isinstance(value, dict)
                  and value.get('type') == 'oauth'
                  and all(isinstance(value.get(field), str) for field in ('access', 'refresh'))
                  and type(value.get('expires')) is int and value['expires'] >= 0]
    if not candidates:
        return
    authorization = 'Basic ' + base64.b64encode(('opencode:' + password).encode()).decode()

    def request(method, body=None):
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
        try:
            connection.request(method, '/api/credential', json.dumps(body) if body is not None else None,
                               {'Authorization': authorization, 'Content-Type': 'application/json'})
            response = connection.getresponse()
            payload = response.read(1024 * 1024 + 1)
            if response.status not in (200, 201) or len(payload) > 1024 * 1024:
                raise ValueError('Credential migration API unavailable')
            return json.loads(payload)
        finally:
            connection.close()

    entries = request('GET')['data']
    copied = []
    for key, old in candidates:
        ident = 'cred_fnos_console_' + hashlib.sha256(json.dumps([key, old], sort_keys=True).encode()).hexdigest()[:32]
        if any(item['id'] == ident for item in entries):
            copied.append(ident)
            continue
        active = next((item for item in entries if item['integrationID'] == 'opencode' and item.get('active')), None)
        same = active and active['value'].get('type') == 'oauth' and (
            active['value'].get('refresh') == old['refresh'] or active['value'].get('access') == old['access'])
        value = {field: old[field] for field in ('access', 'refresh', 'expires')}
        value.update(type='oauth', methodID='device')
        if isinstance(old.get('metadata'), dict):
            value['metadata'] = old['metadata']
        created = request('POST', {'id': ident, 'integrationID': 'opencode',
                                  'label': 'OpenCode Go (fnOS migration)' if key == 'opencode-go' else 'OpenCode Console (fnOS migration)',
                                  'value': value, 'activate': active is None or bool(same)})['data']
        entries.append(created)
        if created.get('active'):
            for item in entries:
                if item['id'] != created['id'] and item['integrationID'] == 'opencode':
                    item['active'] = False
        copied.append(ident)
    temp = marker.with_suffix('.tmp')
    temp.write_text(json.dumps({'version': 1, 'credentials': copied}) + '\n', encoding='utf-8')
    temp.chmod(0o600)
    os.replace(temp, marker)
