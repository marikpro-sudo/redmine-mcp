# Redmine Rails runner: audited initial-status expansion, no issue writes or email.
require 'json'
require 'digest'
# Load the staged implementation under its own constant without redefining the installed plugin.
staged = Module.new
staged.module_eval(File.read(File.join(ENV.fetch('CW_SOURCE'), 'app/models/completed_work_context.rb')))
context_class = staged.const_get(:CompletedWorkContext)
mode = ENV.fetch('CW_MODE', 'audit')
raise 'Unknown mode' unless %w[audit apply verify rollback].include?(mode)
if mode == 'verify'
  raise 'Installed plugin version mismatch' unless Redmine::Plugin.find(:redmine_completed_work).version == '1.1.0'
end
manifest = ENV['CW_MANIFEST']
previous_user = User.current
ActionMailer::Base.perform_deliveries = false

def snapshot_rules
  WorkflowRule.order(:id).map(&:attributes)
end

def check_creation_users(project, users, targets, context_class, require_all:)
  users.map do |user|
    actual_admin = user.admin?
    user.admin = false # Memory only: even the manager/admin must pass ordinary role checks.
    User.current = user
    user.association(:preference).target = UserPreference.new(user: user) unless user.preference
    basic = context_class.build(project, user)
    checks = targets.map do |tracker_id, status_ids|
      tracker = basic[:trackers].find { |t| t[:id] == tracker_id }
      raise 'Tracker unavailable' unless tracker
      allowed_ids = tracker[:initial_statuses].map { |s| s[:id] }
      if require_all
        raise "Initial statuses unavailable for user #{user.id}, tracker #{tracker_id}" unless
          tracker[:can_create] && tracker[:can_assign_self] && (status_ids - allowed_ids).empty?
        status_ids.each do |status_id|
          ctx = context_class.build(project, user, status_id)
          t = ctx[:trackers].find { |v| v[:id] == tracker_id }
          status = t[:selected_status]
          raise 'Selected status unavailable' unless status
          progress = status[:is_closed] ? 100 : 0
          if ctx[:done_ratio_mode] == 'issue_status'
            progress = status[:default_done_ratio]
            raise 'Status-derived completion not configured' unless progress.is_a?(Integer) && (!status[:is_closed] || progress == 100)
          end
          fields = t[:fields].select { |f| f[:required] || ['Модуль SAP', 'Бизнес-заказчик'].include?(f[:name]) }
          values = fields.map do |field|
            raise "Required field not writable: #{field[:id]}" unless field[:writable]
            value = case field[:format]
                    when 'list', 'user' then field[:options].first&.fetch(:value)
                    when 'int' then '1'
                    when 'text', 'string' then 'Read-only validation'
                    else raise "Unsupported required field format: #{field[:format]}"
                    end
            raise "No candidate value for field #{field[:id]}" unless value
            {id: field[:id], value: field[:multiple] ? [value] : value}
          end
          issue = Issue.new(project: project, author: user)
          issue.safe_attributes = {'tracker_id'=>tracker_id, 'status_id'=>status_id,
            'subject'=>'READ ONLY status creation check', 'description'=>'Synthetic data; never saved',
            'assigned_to_id'=>user.id, 'done_ratio'=>progress,
            'custom_fields'=>values.map { |v| {'id'=>v[:id], 'value'=>v[:value]} }}
          raise "Validation failed user=#{user.id}, tracker=#{tracker_id}, status=#{status_id}: #{issue.errors.attribute_names.join(',')}" unless issue.valid?
          raise 'Safe attributes changed selected fields' unless issue.tracker_id == tracker_id && issue.status_id == status_id && issue.assigned_to_id == user.id && issue.done_ratio == progress
          values.each do |v|
            raise "Custom field ignored: #{v[:id]}" unless Array(issue.custom_field_value(v[:id])).map(&:to_s).sort == Array(v[:value]).map(&:to_s).sort
          end
        end
      end
      {tracker: tracker[:name], can_create: tracker[:can_create], required_status_ids: status_ids,
       initial_statuses: tracker[:initial_statuses], all_initial_statuses_allowed: (status_ids - allowed_ids).empty?}
    end
    {user_id: user.id, login: user.login, actual_admin: actual_admin, tested_without_admin_bypass: true,
     roles: user.roles_for_project(project).map(&:name), trackers: checks}
  ensure
    user.admin = actual_admin
  end
end

begin
  ActiveRecord::Base.transaction do
    if %w[audit verify].include?(mode)
      ActiveRecord::Base.connection.execute('SET TRANSACTION READ ONLY')
    else
      ActiveRecord::Base.connection.execute('LOCK TABLE workflows IN SHARE ROW EXCLUSIVE MODE')
    end
    before = snapshot_rules
    counts = [Issue.count, UserPreference.count]
    if mode == 'rollback'
      JSON.parse(File.read(manifest)).fetch('added').each do |attrs|
        row = WorkflowTransition.find_by(id: attrs.fetch('id'))
        next unless row
        raise 'Recorded rule was edited; refusing to delete' unless row.attributes == attrs
        row.destroy!
      end
    else
      project = Project.find_by!(identifier: 'sap-development')
      roles = ['SAP / Разработчик', 'SAP / Руководитель'].map { |name| Role.find_by!(name: name) }
      trackers = project.trackers.where(name: context_class::TRACKERS).order(:id).to_a
      raise 'Expected all five SAP trackers' unless trackers.size == 5
      targets = trackers.to_h { |tracker| [tracker.id, tracker.issue_statuses.map(&:id)] }
      raise 'Tracker has no workflow statuses' if targets.values.any?(&:empty?)
      members = Member.joins(:roles).where(roles: {id: roles.map(&:id)})
      others = Project.joins(:trackers).where(id: members.select(:project_id), trackers: {id: trackers.map(&:id)}).where.not(id: project.id).distinct.pluck(:identifier)
      users = project.users.active.select { |u| (u.roles_for_project(project) & roles).any? }
      roles.each do |role|
        raise "No member to verify role #{role.name}" unless users.any? { |u| u.roles_for_project(project).include?(role) }
        raise "Role lacks add_issues: #{role.name}" unless role.has_permission?(:add_issues)
        raise "Role has tracker-specific add restrictions: #{role.name}" unless role.permissions_all_trackers?(:add_issues) || (trackers.map(&:id) - role.permissions_tracker_ids(:add_issues)).empty?
      end
      puts JSON.generate({mode: mode, other_affected_projects: others, done_ratio_mode: Setting.issue_done_ratio,
        roles: roles.map(&:name), target_statuses: targets})
      if mode == 'apply'
        raise 'Role/trackers shared with other projects; review scope' unless others.empty?
        raise 'New manifest path required' unless manifest && !File.exist?(manifest)
        added = []
        roles.each do |role|
          targets.each do |tracker_id, status_ids|
            status_ids.each do |status_id|
              attrs = {role_id: role.id, tracker_id: tracker_id, old_status_id: 0, new_status_id: status_id, author: false, assignee: false}
              added << WorkflowTransition.create!(attrs).attributes unless WorkflowTransition.exists?(attrs)
            end
          end
        end
        raise 'Unrelated workflow changed' unless snapshot_rules.reject { |r| added.any? { |a| a['id'] == r['id'] } } == before
        puts JSON.pretty_generate({users: check_creation_users(project, users, targets, context_class, require_all: true)})
        File.open(manifest, File::WRONLY | File::CREAT | File::EXCL, 0600) do |file|
          file.write(JSON.pretty_generate({added: added, before_sha256: Digest::SHA256.hexdigest(JSON.generate(before))})); file.flush; file.fsync
        end
      else
        puts JSON.pretty_generate({users: check_creation_users(project, users, targets, context_class, require_all: mode == 'verify')})
        raise 'Read-only audit changed workflow' unless snapshot_rules == before
      end
    end
    raise 'Unexpected task/preference writes' unless [Issue.count, UserPreference.count] == counts
  end
  puts "CREATION_STATUS_#{mode.upcase}_OK"
ensure
  User.current = previous_user
end
