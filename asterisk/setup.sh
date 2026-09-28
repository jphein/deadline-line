#!/usr/bin/env bash
# Generates the demo softphone credentials (gitignored). Prints where they are, not the password.
set -euo pipefail
cd "$(dirname "$0")"
if [[ -f demo-auth.conf ]]; then echo "demo-auth.conf exists; delete it to regenerate"; exit 0; fi
pw=$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)
umask 077
cat > demo-auth.conf <<CONF
[caller-auth]
type=auth
auth_type=userpass
username=caller
password=${pw}
CONF
echo "Wrote asterisk/demo-auth.conf (softphone user: caller, server: 127.0.0.1:5070, UDP). Password is in that file."
