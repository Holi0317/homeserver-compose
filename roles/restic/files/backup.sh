#!/usr/bin/env bash

set -Eeuo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" &>/dev/null && pwd -P)

msg() {
  echo >&2 -e "${1-}"
}

die() {
  local msg=$1
  local code=${2-1} # default exit status 1
  msg "$msg"
  exit "$code"
}

if [ "$USER" != 'restic' ]; then
  die "Run this script with user restic"
fi

RESTIC_BIN=/home/restic/bin/restic
source "${script_dir}/credentials.sh"

# Initialize if the repository is not yet initialized
if ! $RESTIC_BIN snapshots; then
  msg Initializing new repository
  $RESTIC_BIN init
fi

# Backup dnf packages
$RESTIC_BIN backup --stdin --stdin-filename dnf.txt <<EOF
>>>> dnf history userinstalled
$(dnf history userinstalled)

>>>> dnf repolist enabled
$(dnf repolist enabled)

>>>> dnf history
$(dnf history)

>>>> dnf list installed
$(dnf list installed)
EOF

# Backup directories
$RESTIC_BIN backup --exclude-file="${script_dir}/excludes.txt" /etc /home /srv

# Purge snapshot if required
$RESTIC_BIN forget --keep-last 10
