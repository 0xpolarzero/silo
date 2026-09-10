"""Verify release signatures and the exact engine policy without editing the app."""
from pathlib import Path
import sys
from macos_release_signing import verify_bundle

if __name__ == '__main__':
    verify_bundle(Path(sys.argv[1]).resolve())
