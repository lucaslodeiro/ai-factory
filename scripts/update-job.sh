#!/usr/bin/env bash
set -uo pipefail
state_file=${1:?update state file required}
update_script=${2:?update script required}
job_label=${3:?update job label required}

cleanup() {
  # A submitted launchd job can otherwise be relaunched after its program
  # exits. Remove this exact transient label after persisting the final state.
  launchctl remove "$job_label" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Give the dashboard enough time to return the accepted response before its
# LaunchAgent is unloaded. This job belongs to launchd, not to the dashboard.
sleep 1
# Never replay a completed or failed update if launchd invokes this wrapper a
# second time before the transient job has been removed.
node -e 'const fs=require("fs");try{process.exit(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).status==="updating"?0:1)}catch{process.exit(1)}' "$state_file" || exit 0
AI_FACTORY_UPDATE_STATE_FILE=$state_file bash "$update_script" --restart-services
# update.sh has already persisted success or failure. Always finish cleanly;
# the EXIT trap removes the one-shot job in either case.
exit 0
