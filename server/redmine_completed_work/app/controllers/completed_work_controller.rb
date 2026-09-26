class CompletedWorkController < ApplicationController
  accept_api_auth :context
  before_action :find_project_by_project_id

  def context
    return render_403 unless User.current.logged? &&
      User.current.allowed_to?(:view_issues, @project) && User.current.allowed_to?(:add_issues, @project)
    response.headers['Cache-Control'] = 'private, no-store'
    # No saves, no notifications. A new in-memory issue supplies effective workflow rules.
    render json: CompletedWorkContext.build(@project, User.current, params[:status])
  rescue ArgumentError
    render json: {error: 'Unknown or ambiguous status'}, status: :unprocessable_entity
  end
end
