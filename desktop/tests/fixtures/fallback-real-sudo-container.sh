#!/bin/sh
# Run only in a disposable Ubuntu container, as root.
set -eu
FIXTURE_ROOT=${1:-/fixture}
export FIXTURE_ROOT
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -qq -y python3 sudo >/dev/null
useradd -m -s /bin/sh fixture
printf '%s\n' 'fixture:fixture-only-password' | chpasswd
printf '%s\n' 'Defaults:fixture timestamp_timeout=0' 'fixture ALL=(root) ALL' > /etc/sudoers.d/gooeshell-fixture
chmod 440 /etc/sudoers.d/gooeshell-fixture
su -p fixture -c 'HOME=/home/fixture python3 "$FIXTURE_ROOT/tests/fixtures/fallback-real-sudo.py" "$FIXTURE_ROOT/src/main/fallback-task.py"'
