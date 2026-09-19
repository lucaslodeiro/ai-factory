#!/usr/bin/env bash
set -uo pipefail
state_file=${1:?update state file required}
update_script=${2:?update script required}
# Keep the label optional so a job started by an older dashboard can continue
# after update.mjs replaces this script underneath the running shell.
job_label=${3:-}

cleanup() {
  # A submitted launchd job can otherwise be relaunched after its program
  # exits. Remove this exact transient label after persisting the final state.
  [[ -z $job_label ]] || launchctl remove "$job_label" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Give the dashboard enough time to return the accepted response before its
# LaunchAgent is unloaded. This job belongs to launchd, not to the dashboard.
sleep 1
# Never replay a completed or failed update if launchd invokes this wrapper a
# second time before the transient job has been removed.
# launchctl jobs do not necessarily inherit the Node installation's PATH.
# This guard only needs to reject a completed/failed replay, so use macOS base
# tools and let update.sh establish the full toolchain PATH afterward.
/usr/bin/grep -Eq '"status"[[:space:]]*:[[:space:]]*"updating"' "$state_file" || exit 0
AI_FACTORY_UPDATE_STATE_FILE=$state_file bash "$update_script" --restart-services
# update.sh has already persisted success or failure. Always finish cleanly;
# the EXIT trap removes the one-shot job in either case.
exit 0
