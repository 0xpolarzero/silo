"""List one guest folder for Silo's file browser.

The folder is argv[1], never source. Output is NUL-separated: a status, then a
kind and a name per entry. A name that is not valid UTF-8 is shown with
backslash escapes and has kind "u", so the host lists it but never opens it.
Physical cwd rejects symlink ancestors; entries are never followed.
"""
import os
import sys

# Keep in step with MAX_ENTRIES in files.rs and below the host's 1 MiB cap on
# runtime output, so an oversized folder reports "large" instead of failing.
MAX_ENTRIES = 20_000
MAX_BYTES = 960 * 1024


def kind(entry):
    try:
        if entry.is_symlink():
            return b'l'
        if entry.is_dir(follow_symlinks=False):
            return b'd'
    except OSError:
        pass
    return b'f'


def listing(path):
    if not os.path.exists(path):
        return b'missing\0'
    if not os.path.isdir(path):
        return b'invalid\0'
    if not os.access(path, os.R_OK | os.X_OK):
        return b'denied\0'
    try:
        os.chdir(path)
    except OSError:
        return b'denied\0'
    if os.getcwd() != path:
        return b'invalid\0'
    records = []
    size = 0
    try:
        with os.scandir(b'.') as entries:
            for entry in entries:
                try:
                    code, name = kind(entry), entry.name.decode('utf-8')
                except UnicodeDecodeError:
                    code, name = b'u', entry.name.decode('utf-8', 'backslashreplace')
                record = code + b'\0' + name.encode('utf-8') + b'\0'
                size += len(record)
                if len(records) == MAX_ENTRIES or size > MAX_BYTES:
                    return b'large\0'
                records.append(record)
    except PermissionError:
        return b'denied\0'
    return b'ok\0' + b''.join(records)


def main(argv):
    if len(argv) != 2:
        return 2
    sys.stdout.buffer.write(listing(argv[1]))
    sys.stdout.buffer.flush()
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
