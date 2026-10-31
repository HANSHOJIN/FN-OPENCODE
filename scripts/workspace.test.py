"""Execute the startup shell with a fake runtime; never start OpenCode."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BASH = r'C:\Program Files\Git\bin\bash.exe' if os.name == 'nt' else 'bash'
def shellpath(path):
    value=str(path).replace('\\','/')
    return '/'+value[0].lower()+value[2:] if len(value)>1 and value[1]==':' else value

class WorkspaceTests(unittest.TestCase):
    def test_startup_preserves_shared_directory_and_existing_files(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.build') as temp:
            root=Path(temp); lib=root/'app/lib'; lib.mkdir(parents=True)
            workspace=root/'projects'; workspace.mkdir()
            original=workspace/'original.txt'; original.write_text('preserve')
            (root/'app/bin').mkdir()
            executable=root/'app/bin/python3'
            executable.write_text('#!/bin/bash\npwd\nprintf "%s\\n" "$FNOS_WORKSPACE"\n',encoding='utf8')
            executable.chmod(0o755)
            (lib/'common.sh').write_text('export PATH="$TRIM_APPDEST/bin:$PATH"\nprepare() { :; }\nload_settings() { workspace="$TEST_WORKSPACE"; }\n',encoding='utf8')
            env={**os.environ,'TRIM_APPDEST':shellpath(root/'app'),'TEST_WORKSPACE':shellpath(workspace)}
            result=subprocess.run([BASH,shellpath(ROOT/'opencode-fnos/app/lib/run.sh')],env=env,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(result.stdout.strip().splitlines(),[shellpath(workspace)]*2)
            self.assertFalse((workspace/'默认项目').exists())
            self.assertEqual(original.read_text(),'preserve')

if __name__=='__main__':unittest.main()
