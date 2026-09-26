require_relative 'app/models/completed_work_context'

Redmine::Plugin.register :redmine_completed_work do
  name 'Completed SAP work context'
  author 'MedService'
  description 'Read-only effective creation context; issue writes use the standard Redmine API.'
  version '1.1.0'
  requires_redmine version_or_higher: '6.1.0'
end
