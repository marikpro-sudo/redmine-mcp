# SAP creation context 1.1.0

Read-only Redmine >=6.1 plugin for Redmine Access 0.4.0. No migrations or gems.
All five SAP tracker types are supported. The personal-key authenticated GET endpoint requires
view_issues and add_issues on the project. Active, visible customer candidates respect the actual
custom field configuration. No email addresses or keys are returned.

GET /projects/:project_id/completed-work/context.json returns schema_version=2, trackers and
effective initial_statuses. With a status query parameter (exact name or ID), each applicable tracker
also returns selected_status and its required/writable fields. Fields are empty without a selected
permitted status, preventing accidental reuse of requirements from another state.

## Upgrade existing 1.0.0 installation

The server bundle creation-statuses-v0.4.0 contains redmine_completed_work.tar.gz,
creation-status-admin.rb, upgrade-creation-statuses.sh, rollback-creation-statuses.sh and a SHA256 manifest.

    sudo bash /home/marat/redmine-stage1/creation-statuses-v0.4.0/upgrade-creation-statuses.sh audit
    sudo bash /home/marat/redmine-stage1/creation-statuses-v0.4.0/upgrade-creation-statuses.sh

Audit is optional; upgrade always starts with a READ ONLY audit. Do not rerun the old installer.
Both SAP / Разработчик and SAP / Руководитель get initial transitions to every status already used
in the workflow of each of the five SAP tracker types. Existing transitions and required fields remain
unchanged. All other workflow rows are compared before/after. If these role/tracker combinations
are shared with another project, the upgrade stops for scope review.

The audit lists target statuses and all real role members. Managers with administrator accounts
are tested with admin=false IN MEMORY, never saved, so administrator privilege cannot hide missing
role permissions. Upgrade verifies unsaved issues for every actor, tracker and status using normal
safe attributes and validation. Required field data for those checks is explicitly synthetic and
never sent to Redmine as real tasks. No issue save or notifications occur.

Before writes, the script checks a pg_dump archive, saves configuration and previous plugin files.
It adds only missing initial workflow rows, records their exact IDs/attributes, replaces files of
the already installed plugin and restarts Redmine. Existing Compose mounts and SMTP settings remain.
After restart it repeats READ ONLY validation and confirms anonymous HTTP access is denied.
Local client tests and Ruby syntax checks do not substitute for this server runtime validation.

All statuses here means the statuses belonging to the selected tracker's current workflow, not
unrelated statuses from other tracker processes. The privilege also applies to manual issue creation.
The request to ask for status is implemented by harness instructions and mandatory status parameters;
the ordinary Redmine web form naturally lets its user pick a status.

After successful upgrade, restart the MCP process and check creation-context with a personal account.
The client rejects schema 1 and unapplied old drafts lacking a status answer. No production creation
test should be sent until its actual contents are established.

## Rollback

Use the backup path printed by the upgrade:

    sudo bash /home/marat/redmine-stage1/creation-statuses-v0.4.0/rollback-creation-statuses.sh /opt/redmine/backups/pre-creation-statuses-XXXXXXXX

The rollback restores previous plugin files, restarts Redmine, then removes only unchanged workflow
rows recorded in that upgrade's added-rules.json. Existing closed-creation rules from 0.3.0 remain.
Edited recorded rows cause a refusal rather than a broad deletion. Compose is never overwritten.
Automatic failure handling uses this same rollback. Inspect reported logs if restart or rollback
fails; a whole-database restore is never attempted automatically.
