"""Bound native log growth; copy/truncate preserves the writer's open inode."""
from pathlib import Path
import os
import shutil
import sys
import time


def rotate_logs(directory, limit=10 * 1024 * 1024, keep=3):
    for log in directory.glob('*.log'):
        if log.is_symlink() or not log.is_file() or log.stat().st_size <= limit:
            continue
        archives = [Path(str(log) + '.' + str(i)) for i in range(1, keep + 1)]
        temporary = Path(str(log) + '.rotate')
        if any(p.is_symlink() for p in [*archives, temporary]):
            continue
        # Native logger keeps this file open. Renaming the active file alone
        # would leave it writing to an unbounded archived inode.
        with log.open('r+b') as current:
            with temporary.open('wb') as saved:
                os.chmod(temporary, 0o600)
                shutil.copyfileobj(current, saved)
                saved.flush()
                os.fsync(saved.fileno())
            for index in range(keep - 1, 0, -1):
                if archives[index - 1].exists():
                    archives[index - 1].replace(archives[index])
            temporary.replace(archives[0])
            current.truncate(0)


if __name__ == '__main__':
    parent = os.getppid()
    directory = Path(sys.argv[1])
    while os.getppid() == parent:
        try:
            rotate_logs(directory)
        except OSError as error:
            print('Native log maintenance failed:', type(error).__name__, file=sys.stderr, flush=True)
        time.sleep(30)
