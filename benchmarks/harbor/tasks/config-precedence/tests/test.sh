#!/bin/bash
set -euo pipefail
mkdir -p /logs/verifier
printf '0\n' > /logs/verifier/reward.txt
chmod -R go-rwx /tests
chmod 700 /logs/verifier
exec python3 /tests/verify.py --sandbox
