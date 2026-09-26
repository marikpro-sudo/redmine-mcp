class CompletedWorkContext
  TRACKERS = ['Ошибка', 'Доработка', 'Новая разработка', 'Консультация', 'Перенос SAP'].freeze

  def self.status_data(status)
    {id: status.id, name: status.name, is_closed: status.is_closed?, default_done_ratio: status.default_done_ratio}
  end

  def self.build(project, user, selected_status = nil)
    previous_user = User.current
    User.current = user
    user.association(:preference).target = UserPreference.new(user: user) unless user.preference
    selection = nil
    if selected_status.present?
      matches = IssueStatus.where(id: selected_status.to_s.match?(/\A\d+\z/) ? selected_status.to_i : nil).to_a
      matches = IssueStatus.where(name: selected_status.to_s).to_a if matches.empty?
      raise ArgumentError, 'Unknown or ambiguous status' unless matches.size == 1
      selection = matches.first
    end
    allowed_trackers = Issue.new(project: project, author: user).allowed_target_trackers(user).map(&:id)
    {
      schema_version: 2, actor_id: user.id,
      project: {id: project.id, name: project.name, identifier: project.identifier}, done_ratio_mode: Setting.issue_done_ratio,
      trackers: project.trackers.where(name: TRACKERS).order(:id).map do |tracker|
        issue = Issue.new(project: project, tracker: tracker, author: user, assigned_to: user)
        initial = issue.new_statuses_allowed_to(user)
        selected = selection && initial.find { |s| s.id == selection.id }
        common = {id: tracker.id, name: tracker.name,
          can_create: user.allowed_to?(:add_issues, project) && allowed_trackers.include?(tracker.id),
          can_assign_self: issue.assignable_users.any? { |candidate| candidate.id == user.id },
          initial_statuses: initial.map { |s| status_data(s) }, selected_status: selected && status_data(selected)}
        unless selected
          next common.merge(writable_core: [], required_attributes: [], fields: [])
        end
        issue.status = selected
        writable = issue.editable_custom_fields(user).map(&:id)
        required = issue.required_attribute_names(user)
        fields = issue.visible_custom_field_values(user).map(&:custom_field).map do |field|
          options = case field.field_format
                    when 'user'
                      field.format.possible_values_records(field, issue).select { |u| u.active? && u.visible?(user) }
                           .map { |u| {value: u.id.to_s, label: u.name} }
                    when 'list'
                      field.possible_values.map { |value| {value: value, label: value} }
                    else []
                    end
          {id: field.id, name: field.name, format: field.field_format, multiple: field.multiple?,
           required: field.is_required? || required.include?(field.id.to_s), writable: writable.include?(field.id), options: options}
        end
        all_required = required | issue.available_custom_fields.select(&:is_required?).map { |f| f.id.to_s }
        common.merge(writable_core: issue.safe_attribute_names(user), required_attributes: all_required, fields: fields)
      end
    }
  ensure
    User.current = previous_user
  end
end
