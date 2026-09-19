#!/usr/bin/env bash
set -uo pipefail
state_file=${1:?update state file required}
update_script=${2:?update script required}

# Give the dashboard enough time to return the accepted response before its
# LaunchAgent is unloaded. This job belongs to launchd, not to the dashboard.
sleep 1
AI_FACTORY_UPDATE_STATE_FILE=$state_file bash "$update_script" --restart-services
# launchctl submit restarts failed jobs. update.sh has already persisted the
# failure, so this wrapper must finish successfully and leave it for the user.
exit 0
