#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ $EUID -eq 0 ]] || { echo 'Run with sudo.'; exit 1; }
MODE=${1:-upgrade}
[[ "$MODE" == audit || "$MODE" == upgrade ]] || { echo 'Expected audit or upgrade'; exit 1; }
SOURCE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd /opt/redmine
exec 9>/opt/redmine/install-completed-work.lock
flock -n 9 || { echo 'Another creation integration operation is running.'; exit 1; }
TARGET=/opt/redmine/plugins/redmine_completed_work
[[ -d "$TARGET" && -f compose.override.yaml && -z "${COMPOSE_FILE:-}" ]] || { echo 'Expected existing completed-work installation'; exit 1; }
docker compose exec -T redmine test -f /usr/src/redmine/plugins/redmine_completed_work/init.rb
(cd "$SOURCE" && sha256sum -c CREATION-STATUS-SHA256SUMS)
RUN=$(mktemp -d /opt/redmine/backups/pre-creation-statuses-XXXXXXXX)
exec > >(tee -a "$RUN/upgrade.log") 2>&1
mkdir "$RUN/new"
tar -tzf "$SOURCE/redmine_completed_work.tar.gz" > "$RUN/archive-files.txt"
if grep -Eq '(^/|(^|/)\.\.(/|$))' "$RUN/archive-files.txt"; then echo 'Unsafe archive path'; exit 1; fi
tar -xzf "$SOURCE/redmine_completed_work.tar.gz" -C "$RUN/new"
install -m 600 "$SOURCE/creation-status-admin.rb" "$RUN/creation-status-admin.rb"
REMOTE="/tmp/$(basename "$RUN")"
docker compose exec -T redmine mkdir -m 755 "$REMOTE"
docker compose cp "$RUN/new/redmine_completed_work" "redmine:$REMOTE/"
docker compose cp "$RUN/creation-status-admin.rb" "redmine:$REMOTE/creation-status-admin.rb"
UID_APP=$(docker compose exec -T redmine id -u redmine)
GID_APP=$(docker compose exec -T redmine id -g redmine)
[[ "$UID_APP" =~ ^[0-9]+$ && "$GID_APP" =~ ^[0-9]+$ ]]
docker compose exec -T redmine chown -R "$UID_APP:$GID_APP" "$REMOTE"
docker compose exec -T redmine chmod -R u+rX "$REMOTE"
docker compose exec -T redmine bash -c 'set -e; find "$1" -name "*.rb" -print0 | xargs -0 -n1 ruby -c' bash "$REMOTE"
run_admin() {
  local context_source="$REMOTE/redmine_completed_work"
  if [[ "$1" == verify ]]; then context_source=/usr/src/redmine/plugins/redmine_completed_work; fi
  docker compose exec -T --user redmine -e CW_MODE="$1" -e CW_SOURCE="$context_source" -e CW_MANIFEST="$REMOTE/added-rules.json" redmine bash -c 'export SECRET_KEY_BASE="${SECRET_KEY_BASE:-${REDMINE_SECRET_KEY_BASE:-}}"; exec bundle exec rails runner "$1"' bash "$REMOTE/creation-status-admin.rb"
}
run_admin audit | tee "$RUN/audit-before.log"
if [[ "$MODE" == audit ]]; then echo "AUDIT_ONLY_COMPLETE: $RUN; database unchanged"; exit 0; fi
cp -a "$TARGET" "$RUN/previous-plugin"
tar -czf "$RUN/configuration.tar.gz" .env compose.yaml compose.override.yaml configuration-smtp.yml
docker compose exec -T db pg_dump -U redmine -d redmine -Fc > "$RUN/redmine.dump"
test -s "$RUN/redmine.dump"
docker compose exec -T db pg_restore --list < "$RUN/redmine.dump" > "$RUN/dump-contents.txt"
rollback() {
  trap - ERR
  docker compose cp "redmine:$REMOTE/added-rules.json" "$RUN/added-rules.json" 2>/dev/null || true
  bash "$SOURCE/rollback-creation-statuses.sh" "$RUN" || echo 'ROLLBACK_FAILED: inspect backup and exact rule manifest; no broad DB restore attempted.'
  echo "UPGRADE_FAILED: $RUN"; exit 1
}
trap rollback ERR
run_admin apply | tee "$RUN/workflow-apply.log"
docker compose cp "redmine:$REMOTE/added-rules.json" "$RUN/added-rules.json"
chmod 600 "$RUN/added-rules.json"
# Existing directory bind and filenames remain unchanged; restart reloads the replacement source.
cp -a "$RUN/new/redmine_completed_work/." "$TARGET/"
chown -R "$UID_APP:$GID_APP" "$TARGET"
find "$TARGET" -type d -exec chmod 755 {} +
find "$TARGET" -type f -exec chmod 644 {} +
docker compose restart redmine
ready=0
for attempt in $(seq 1 60); do
  if curl --noproxy '*' --resolve redmine.medservice.kz:443:127.0.0.1 --fail --silent --max-time 5 https://redmine.medservice.kz/login -o /dev/null; then ready=1; break; fi
  sleep 3
done
[[ "$ready" == 1 ]]
run_admin verify | tee "$RUN/verification.log"
HTTP_CODE=$(curl --noproxy '*' --resolve redmine.medservice.kz:443:127.0.0.1 --silent --show-error --max-time 20 -o /dev/null -w '%{http_code}' https://redmine.medservice.kz/projects/sap-development/completed-work/context.json)
[[ "$HTTP_CODE" == 302 || "$HTTP_CODE" == 401 || "$HTTP_CODE" == 403 ]]
trap - ERR
echo "Backup and rollback manifest: $RUN"
echo 'SUCCESS: CREATION_STATUSES_UPGRADED; no issues or notifications created.'
