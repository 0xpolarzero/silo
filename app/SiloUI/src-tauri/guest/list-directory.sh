#!/bin/bash
# Path is a positional argument, never shell source. Physical cwd rejects
# symlink ancestors; find does not descend into or follow directory entries.
if [[ ! -e "$1" ]]; then printf 'missing\0'; exit 0; fi
if [[ ! -d "$1" ]]; then printf 'invalid\0'; exit 0; fi
if [[ ! -r "$1" || ! -x "$1" ]]; then printf 'denied\0'; exit 0; fi
cd -P -- "$1" 2>/dev/null || { printf 'denied\0'; exit 0; }
[[ "$PWD" == "$1" ]] || { printf 'invalid\0'; exit 0; }
printf 'ok\0'
find -P . -mindepth 1 -maxdepth 1 -printf '%y\0%f\0'
