"""Validate both health endpoints without exposing credentials in arguments."""
import base64
import http.client
import json
from pathlib import Path
import socket
import sys


def healthy(connection, url, headers):
    try:
        connection.request('GET', url, headers=headers)
        response = connection.getresponse()
        data = response.read(65537)
        if response.status != 200 or len(data) > 65536:
            return False
        result = json.loads(data)
        return isinstance(result, dict) and result.get('healthy') is True
    except (OSError, ValueError, http.client.HTTPException):
        return False
    finally:
        connection.close()


def check(target, etc):
    protocol = json.loads((target / 'gateway/protocol.json').read_text())
    username = (etc / 'web.username').read_text().rstrip('\n')
    password = (etc / 'web.password').read_text().rstrip('\n')
    port = int((etc / 'web.port').read_text())
    auth = base64.b64encode((username + ':' + password).encode()).decode()
    if not healthy(http.client.HTTPConnection('127.0.0.1', port, timeout=3), '/global/health', {'Authorization': 'Basic ' + auth}):
        return False

    class UnixHTTP(http.client.HTTPConnection):
        def connect(self):
            self.sock = socket.socket(socket.AF_UNIX)
            self.sock.settimeout(self.timeout)
            self.sock.connect(str(target / 'app.sock'))

    return healthy(UnixHTTP('localhost', timeout=3), protocol['prefix'] + '/global/health', {
        protocol['headers']['userID']: '0', protocol['headers']['isAdmin']: 'true',
    })


if __name__ == '__main__':
    try:
        sys.exit(0 if check(Path(sys.argv[1]), Path(sys.argv[2])) else 1)
    except (OSError, ValueError, KeyError):
        sys.exit(1)
