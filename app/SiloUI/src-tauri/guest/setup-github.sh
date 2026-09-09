#!/bin/sh
# Run only inside a managed Silo VM. No host credential is passed to this script.
set -eu
if ! command -v git >/dev/null 2>&1 || ! command -v gh >/dev/null 2>&1 || ! command -v git-lfs >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 update
    apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 install -y --no-install-recommends ca-certificates git git-lfs gh
fi
mkdir -p /usr/local/libexec
cat > /usr/local/libexec/silo-github-credential.tmp <<'HELPER'
#!/bin/sh
# Git and Git LFS receive the stable placeholder, never a real GitHub token.
[ "${1:-}" = get ] || exit 0
protocol=
host=
while IFS= read -r line && [ -n "$line" ]; do
    case "$line" in
        protocol=*) protocol=${line#protocol=} ;;
        host=*) host=${line#host=} ;;
    esac
done
[ "$protocol" = https ] && [ "$host" = github.com ] || exit 0
printf '%s\n' 'username=x-access-token' 'password=$MSB_SILO_GITHUB'
HELPER
chmod 0755 /usr/local/libexec/silo-github-credential.tmp
mv /usr/local/libexec/silo-github-credential.tmp /usr/local/libexec/silo-github-credential
git config --system --replace-all credential.https://github.com.helper /usr/local/libexec/silo-github-credential
git lfs install --system --skip-repo
git --version
git lfs version
gh --version
