#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ $EUID -eq 0 && $# == 1 ]] || { echo 'Pass the pre-creation-statuses backup directory, with sudo'; exit 1; }
RUN=$(realpath -- "$1")
[[ "$RUN" =~ ^/opt/redmine/backups/pre-creation-statuses-[A-Za-z0-9]+$ ]] || { echo 'Unexpected backup directory'; exit 1; }
[[ -d "$RUN/previous-plugin" && -f "$RUN/creation-status-admin.rb" && -d "$RUN/new/redmine_completed_work" ]]
cd /opt/redmine
TARGET=/opt/redmine/plugins/redmine_completed_work
[[ -d "$TARGET" ]]
cp -a "$RUN/previous-plugin/." "$TARGET/"
docker compose restart redmine
ready=0
for attempt in $(seq 1 60); do
  if curl --noproxy '*' --resolve redmine.medservice.kz:443:127.0.0.1 --fail --silent --max-time 5 https://redmine.medservice.kz/login -o /dev/null; then ready=1; break; fi
  sleep 3
done
[[ "$ready" == 1 ]]
if [[ -f "$RUN/added-rules.json" ]]; then
  REMOTE="/tmp/rollback-$(basename "$RUN")"
  docker compose exec -T redmine mkdir -p -m 755 "$REMOTE"
  docker compose cp "$RUN/creation-status-admin.rb" "redmine:$REMOTE/creation-status-admin.rb"
  docker compose cp "$RUN/new/redmine_completed_work" "redmine:$REMOTE/"
  docker compose cp "$RUN/added-rules.json" "redmine:$REMOTE/added-rules.json"
  UID_APP=$(docker compose exec -T redmine id -u redmine)
  GID_APP=$(docker compose exec -T redmine id -g redmine)
  docker compose exec -T redmine chown -R "$UID_APP:$GID_APP" "$REMOTE"
  docker compose exec -T redmine chmod -R u+rX "$REMOTE"
  docker compose exec -T --user redmine -e CW_MODE=rollback -e CW_SOURCE="$REMOTE/redmine_completed_work" -e CW_MANIFEST="$REMOTE/added-rules.json" redmine bash -c 'export SECRET_KEY_BASE="${SECRET_KEY_BASE:-${REDMINE_SECRET_KEY_BASE:-}}"; exec bundle exec rails runner "$1"' bash "$REMOTE/creation-status-admin.rb"
else
  # The apply transaction normally rolled back before writing a manifest. Never guess rule IDs.
  echo 'No rule manifest: inspect workflow-apply.log if database commit status is uncertain.'
fi
echo 'CREATION_STATUS_ROLLBACK_OK; previous plugin restored; Compose and other workflow rules preserved.'
