#!/bin/sh
# Read-only check of the tools and integration supplied by Silo's image.
set -eu
git --version
git lfs version
gh --version
test -s /etc/ssl/certs/ca-certificates.crt
test -x /usr/local/libexec/silo-github-credential
test "$(git config --system --get credential.https://github.com.helper)" = /usr/local/libexec/silo-github-credential
