"""Validate both health endpoints without exposing credentials in arguments."""
import base64
import http.client
import json
import re
from pathlib import Path
import socket
import sys


def healthy(connection, url, headers, mode='legacy'):
    try:
        connection.request('GET', url, headers=headers)
        response = connection.getresponse()
        data = response.read(65537)
        if response.status != 200 or len(data) > 65536:
            return False
        result = json.loads(data)
        if mode == 'info':
            return (isinstance(result, dict) and isinstance(result.get('version'), str)
                    and re.fullmatch(r'\d+\.\d+\.\d+(?:[-+][\w.-]+)?', result['version']) is not None
                    and type(result.get('pid')) is int and result['pid'] > 0
                    and isinstance(result.get('urls'), list))
        return isinstance(result, dict) and result.get('healthy') is True
    except (OSError, ValueError, http.client.HTTPException):
        return False
    finally:
        connection.close()


def check(target, etc):
    protocol = json.loads((target / 'gateway/protocol.json').read_text())
    username = protocol.get('backendUsername') or (etc / 'web.username').read_text().rstrip('\n')
    password = (etc / 'web.password').read_text().rstrip('\n')
    port = int((etc / 'web.port').read_text())
    auth = base64.b64encode((username + ':' + password).encode()).decode()
    health_path, mode = protocol.get('healthPath', '/global/health'), protocol.get('healthMode', 'legacy')
    if not healthy(http.client.HTTPConnection('127.0.0.1', port, timeout=3), health_path, {'Authorization': 'Basic ' + auth}, mode):
        return False

    class UnixHTTP(http.client.HTTPConnection):
        def connect(self):
            self.sock = socket.socket(socket.AF_UNIX)
            self.sock.settimeout(self.timeout)
            self.sock.connect(str(target / 'app.sock'))

    return healthy(UnixHTTP('localhost', timeout=3), protocol['prefix'] + health_path, {
        protocol['headers']['userID']: '0', protocol['headers']['isAdmin']: 'true',
    }, mode)


if __name__ == '__main__':
    try:
        sys.exit(0 if check(Path(sys.argv[1]), Path(sys.argv[2])) else 1)
    except (OSError, ValueError, KeyError):
        sys.exit(1)
