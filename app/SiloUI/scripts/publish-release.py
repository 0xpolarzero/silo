"""Publish the complete, verified matrix to the rolling latest GitHub release."""
import hashlib
import json
import os
from pathlib import Path
import subprocess


def gh(*args):
    return subprocess.check_output(["gh", *args], text=True).strip()


def main():
    root = Path("release-assets")
    expected = {
        "Silo-macos-arm64.app.tar.gz",
        "Silo-macos-arm64.dmg",
        "Silo-linux-x64.deb",
        "Silo-linux-arm64.deb",
    }
    actual = {p.name for p in root.iterdir() if p.is_file()}
    if actual != expected or any((root / name).stat().st_size == 0 for name in expected):
        raise RuntimeError("Release assets are missing, empty, or unexpected; keeping the previous release.")
    repository = os.environ["GH_REPO"]
    sha = os.environ["GITHUB_SHA"]
    # A queued run can already have been superseded on main. Never move latest backwards.
    head = gh("api", f"repos/{repository}/commits/main", "--jq", ".sha")
    if head != sha:
        print("A newer main commit exists; leaving latest unchanged.")
        return
    checksums = []
    for name in sorted(expected):
        with (root / name).open("rb") as asset:
            digest = hashlib.file_digest(asset, "sha256").hexdigest()
        checksums.append(f"{digest}  {name}\n")
    (root / "SHA256SUMS").write_text("".join(checksums))
    notes = Path("release-notes.md")
    notes.write_text(
        f"Built from [{sha}](https://github.com/{repository}/commit/{sha}).\n\n"
        "Rolling build from main. Downloads are replaced after the complete build matrix succeeds.\n\n"
        "- macOS: Apple Silicon, macOS 14 or newer. Ad-hoc signed, not notarized; macOS may block the download pending user approval.\n"
        "- Linux: x86-64 and ARM64 Debian packages built on Ubuntu 24.04. Use Ubuntu 24.04 or a compatible newer distribution; local VMs require KVM.\n"
        "- Windows and Intel macOS are not supported by the bundled runtime.\n\n"
        "Build and unit checks do not certify VM execution on every target. Verify downloads with SHA256SUMS.\n"
    )
    releases = json.loads(gh("api", "--paginate", f"repos/{repository}/releases", "--jq", ".[] | select(.tag_name == \"latest\")") or "null")
    refs = json.loads(gh("api", f"repos/{repository}/git/matching-refs/tags/latest"))
    if any(ref["ref"] == "refs/tags/latest" for ref in refs):
        gh("api", "--method", "PATCH", f"repos/{repository}/git/refs/tags/latest", "-f", f"sha={sha}", "-F", "force=true")
    else:
        gh("api", "--method", "POST", f"repos/{repository}/git/refs", "-f", "ref=refs/tags/latest", "-f", f"sha={sha}")
    assets = [str(root / name) for name in sorted(expected | {"SHA256SUMS"})]
    if releases:
        gh("release", "upload", "latest", *assets, "--clobber")
        for asset in releases["assets"]:
            if asset["name"] not in expected | {"SHA256SUMS"}:
                gh("release", "delete-asset", "latest", asset["name"], "--yes")
        gh("release", "edit", "latest", "--title", "Silo latest", "--notes-file", str(notes), "--latest", "--draft=false", "--prerelease=false")
    else:
        gh("release", "create", "latest", *assets, "--verify-tag", "--title", "Silo latest", "--notes-file", str(notes), "--latest")
    print(f"Published https://github.com/{repository}/releases/tag/latest")


if __name__ == "__main__":
    main()
