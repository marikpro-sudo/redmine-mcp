import { z } from 'zod';
import { AccessError, safeError } from './config.js';
import { creationPolicy } from './creation-policy.js';
import { markupPolicy, assertMarkdown } from './markup-policy.js';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const project = z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/).optional();
const nonempty = z.string().trim().min(1).max(10000);
const named = z.union([id, z.string().trim().min(1).max(200)]);
export const creationFields = {
  sap_module: ['Модуль SAP', 'list'], business_customer: ['Бизнес-заказчик', 'user'],
  acceptance_criteria: ['Критерии приёмки', 'text'], dev_transports: ['Транспортные запросы DEV', 'text'],
  test_system: ['Система и мандант теста', 'string'], test_result: ['Результат тестирования', 'text'],
  ai_participation: ['Участие ИИ', 'list']
};
export const createDefinitions = {
  redmine_creation_context: { description: 'Read effective creation permissions, trackers, SAP fields and actual business customer candidates for the selected project. Requires the read-only redmine_completed_work server plugin.\n' + creationPolicy,
    schema: z.object({ project, status: named.optional() }).strict() },
  redmine_prepare_create_issue: { description: 'Prepare a SAP issue locally in the explicitly confirmed status. Ask the user which status before EVERY creation, wait for the answer, then gather required real facts. Does not publish. description, acceptance_criteria, test_result and other text fields must be Markdown; Textile is rejected.\n' + markupPolicy + '\n' + creationPolicy,
    readOnly: false, destructive: false, idempotent: false,
    schema: z.object({ project, tracker: z.enum(['Ошибка', 'Доработка', 'Новая разработка', 'Консультация', 'Перенос SAP']),
      status: named, status_confirmed: z.literal(true), done_ratio: z.number().int().min(0).max(100).optional(),
      subject: z.string().trim().min(1).max(255), description: nonempty, business_customer: named.optional(), sap_module: nonempty,
      acceptance_criteria: nonempty.optional(), dev_transports: nonempty.optional(), test_system: z.string().trim().min(1).max(255).optional(), test_result: nonempty.optional(),
      custom_fields: z.array(z.object({ id, value: z.union([nonempty, z.array(nonempty).min(1).max(100)]) }).strict()).max(100).default([]),
      ai_participation: z.enum(['Не указано', 'Без ИИ', 'ИИ помогал', 'Решение подготовлено ИИ и проверено разработчиком']).optional() }).strict() },
  redmine_apply_create_issue: { description: 'Apply one prepared creation on the user’s explicit request after they answered the status question. At most one POST attempt. Never retry uncertain creation with a new operation ID.\n' + creationPolicy,
    readOnly: false, destructive: true, idempotent: true,
    schema: z.object({ operation_id: z.string().uuid() }).strict() }
};
const fail = (code, message) => { throw new AccessError(code, message); };
const canonical = v => typeof v === 'string' ? v.replace(/\r\n?/g, '\n') : v;

export class CreateService {
  constructor(service) { this.service = service; this.client = service.client; this.store = service.writes.store; }

  async context(project, status) {
    const key = project || this.service.config.defaultProject;
    if (!key) fail('PROJECT_REQUIRED', 'Choose a project or configure REDMINE_PROJECT.');
    let data;
    try { data = await this.client.get(`projects/${encodeURIComponent(key)}/completed-work/context.json`, { status }); }
    catch (e) {
      if (e.code === 'HTTP_404') fail('CONTEXT_UNAVAILABLE', 'Project is unavailable or the redmine_completed_work plugin is not installed. No creation attempted.');
      throw e;
    }
    if (data.schema_version !== 2) fail('SERVER_UPGRADE_REQUIRED', 'Install creation-context server plugin 1.1.0 before creating tasks.');
    if (!Number.isSafeInteger(data.project?.id) || !Number.isSafeInteger(data.actor_id) || !Array.isArray(data.trackers)) {
      fail('BAD_RESPONSE', 'Invalid creation context.');
    }
    return data;
  }

  payload(a, context, actor) {
    if (a.status_confirmed !== true || a.status === undefined) fail('STATUS_CONFIRMATION_REQUIRED', 'Ask the user which status to use and wait for their answer before preparing creation.');
    if (context.actor_id !== actor.id) fail('ACTOR_CHANGED', 'Creation context belongs to a different user.');
    const matches = context.trackers.filter(t => t.name === a.tracker);
    if (matches.length !== 1) fail('TRACKER_UNAVAILABLE', 'Requested tracker is unavailable or ambiguous.');
    const t = matches[0];
    const status = t.selected_status;
    if (!t.can_create || !status || !t.initial_statuses.some(s => s.id === status.id) ||
        !(String(status.id) === String(a.status) || status.name === a.status)) fail('TRANSITION_DENIED', 'Creating in the selected status is not allowed for this account and tracker.');
    if (!t.can_assign_self) fail('ASSIGNEE_DENIED', 'This account cannot be assigned to the new issue.');
    const core = ['subject', 'description', 'assigned_to_id', 'status_id'];
    if (!core.every(f => t.writable_core.includes(f))) fail('FIELDS_UNAVAILABLE', 'Required fields cannot be set with the current workflow.');
    if (status.is_closed && a.done_ratio !== undefined && a.done_ratio !== 100) fail('INVALID_PROGRESS', 'Closed status requires completion 100%.');
    let progress = status.is_closed ? 100 : (a.done_ratio ?? 0);
    if (context.done_ratio_mode === 'issue_status') {
      if (!Number.isInteger(status.default_done_ratio) || (status.is_closed && status.default_done_ratio !== 100) ||
          (a.done_ratio !== undefined && a.done_ratio !== status.default_done_ratio)) fail('FIELDS_UNAVAILABLE', 'Progress is controlled by status and conflicts with the requested completion.');
      progress = status.default_done_ratio;
    } else if (context.done_ratio_mode !== 'issue_field' || !t.writable_core.includes('done_ratio')) {
      fail('FIELDS_UNAVAILABLE', 'Completion cannot be set with the current workflow.');
    }
    const custom_fields = [];
    const addField = (field, value) => {
      if (!field.writable) fail('FIELDS_UNAVAILABLE', `Field is not writable: ${field.name}.`);
      if (custom_fields.some(f => f.id === field.id)) fail('DUPLICATE_FIELD', 'Supply each custom field only once.');
      if (Array.isArray(value) !== field.multiple) fail('INVALID_FIELD_VALUE', `Wrong multiplicity for ${field.name}.`);
      const values = Array.isArray(value) ? value : [value];
      if (['list', 'user'].includes(field.format) && values.some(v => !field.options.some(o => String(o.value) === String(v)))) fail('INVALID_FIELD_VALUE', `Select offered values for ${field.name}.`);
      if (field.format === 'int' && values.some(v => !/^[+-]?\d+$/.test(v))) fail('INVALID_FIELD_VALUE', `Integer required for ${field.name}.`);
      if (!['list', 'user', 'int', 'text', 'string'].includes(field.format)) fail('FIELDS_UNAVAILABLE', `Unsupported field format: ${field.name}.`);
      custom_fields.push({ id: field.id, value });
    };
    for (const [key, [name, format]] of Object.entries(creationFields)) {
      const fields = t.fields.filter(f => f.name === name);
      let value = a[key];
      if (key === 'ai_participation' && value === undefined && fields.length === 1 && !(a.custom_fields || []).some(f => f.id === fields[0].id)) value = 'ИИ помогал';
      if (value === undefined) continue;
      if (fields.length !== 1 || fields[0].format !== format || fields[0].multiple || !fields[0].writable) fail('FIELDS_UNAVAILABLE', `Field unavailable, ambiguous or incompatible: ${name}.`);
      const field = fields[0];
      if (format === 'user') {
        const candidates = field.options.filter(o => String(o.value) === String(value) || o.label === value);
        if (candidates.length !== 1) fail('CUSTOMER_UNRESOLVED', 'Choose an exact business customer ID from redmine_creation_context.');
        value = String(candidates[0].value);
      } else if (format === 'list' && !field.options.some(o => o.value === value)) fail('INVALID_FIELD_VALUE', `Select an offered value for ${name}.`);
      addField(field, value);
    }
    for (const input of a.custom_fields || []) {
      const fields = t.fields.filter(f => f.id === input.id);
      if (fields.length !== 1) fail('FIELDS_UNAVAILABLE', 'Custom field is not available for the selected tracker and status.');
      addField(fields[0], input.value);
    }
    const missing = t.fields.filter(f => (f.required || f.name === 'Бизнес-заказчик' || f.name === 'Модуль SAP') && !custom_fields.some(v => v.id === f.id));
    if (missing.length) fail('MISSING_FIELDS', `Ask the user for: ${missing.map(f => f.name).join(', ')}. Nothing created.`);
    custom_fields.sort((a, b) => a.id - b.id);
    const supported = new Set(['subject', 'description', 'assigned_to_id', 'status_id', 'done_ratio', 'priority_id', 'project_id', 'tracker_id', ...custom_fields.map(f => String(f.id))]);
    if (t.required_attributes.some(f => !supported.has(f))) fail('UNSUPPORTED_REQUIRED_FIELDS', 'Workflow requires additional fields. Inspect redmine_creation_context; creation was not attempted.');
    return { project_id: context.project.id, tracker_id: t.id, status_id: status.id,
      assigned_to_id: actor.id, subject: a.subject, description: a.description, done_ratio: progress, custom_fields };
  }

  async prepare(a) {
    // Free-text values only; list values are validated against offered options later.
    const customText = (a.custom_fields || []).flatMap(f => [f.value].flat().map(v => [`custom_fields[${f.id}]`, v]));
    assertMarkdown([...Object.entries({ subject: a.subject, description: a.description, acceptance_criteria: a.acceptance_criteria,
      dev_transports: a.dev_transports, test_system: a.test_system, test_result: a.test_result }), ...customText]);
    const actor = await this.service.me(); const context = await this.context(a.project, a.status);
    const payload = this.payload(a, context, actor);
    const input = { ...a, project: String(context.project.id), status: payload.status_id };
    const status = context.trackers.find(t => t.id === payload.tracker_id).selected_status;
    // Bind names to exact IDs/values in the immutable payload; later context changes reject rather than retarget.
    const preview = { kind: 'create_issue', actor, project: context.project, tracker: a.tracker, subject: a.subject,
      description: a.description, status: status.name, status_id: status.id, is_closed: status.is_closed, status_confirmed: true, done_ratio: payload.done_ratio, assigned_to: actor,
      custom_fields: payload.custom_fields.map(f => ({ ...f, name: context.trackers.find(t => t.id === payload.tracker_id).fields.find(x => x.id === f.id).name })),
      notification_notice: 'Applying may send normal Redmine notifications.', creation_rule: creationPolicy };
    const record = { kind: 'create_issue', actor_id: actor.id, input, payload, preview, expires_at: new Date(Date.now() + 30 * 60000).toISOString() };
    const operation_id = await this.store.create(record);
    return { operation_id, state: 'prepared', expires_at: record.expires_at, ...preview };
  }

  async apply(operation_id) {
    const record = await this.store.read(operation_id); const actor = await this.service.me();
    if (record.kind !== 'create_issue') fail('OPERATION_KIND', 'Use redmine_apply_change for update operations.');
    if (record.actor_id !== actor.id) fail('ACTOR_CHANGED', 'Operation belongs to another user.');
    const previous = await this.store.result(operation_id);
    if (previous) return { operation_id, ...previous, replayed: true };
    if (!await this.store.claim(operation_id)) return { operation_id, state: 'in_progress_or_uncertain', message: 'Creation already started. Do not resend.' };
    let started = false; let issue_id; let result;
    try {
      if (Date.now() > Date.parse(record.expires_at)) fail('EXPIRED', 'Creation draft expired. Nothing created.');
      if (!record.input.status_confirmed || record.input.status === undefined) fail('STATUS_CONFIRMATION_REQUIRED', 'Old creation draft: ask the user for status and prepare a new draft.');
      const context = await this.context(record.input.project, record.input.status);
      const currentPayload = this.payload(record.input, context, actor);
      if (JSON.stringify(currentPayload) !== JSON.stringify(record.payload)) fail('CONTEXT_CHANGED', 'Creation fields or IDs changed. Prepare a fresh draft.');
      started = true;
      issue_id = await this.client.createIssue(record.payload);
      const after = await this.service.rawIssue(issue_id);
      const mismatches = [];
      const refs = { project_id: 'project', tracker_id: 'tracker', status_id: 'status', assigned_to_id: 'assigned_to' };
      for (const [field, expected] of Object.entries(record.payload)) {
        if (field === 'custom_fields') {
          for (const f of expected) {
            const normalize = v => Array.isArray(v) ? v.map(canonical).sort() : canonical(v);
            if (JSON.stringify(normalize(after.custom_fields?.find(x => x.id === f.id)?.value)) !== JSON.stringify(normalize(f.value))) mismatches.push(`custom_field:${f.id}`);
          }
        } else if (canonical(refs[field] ? after[refs[field]]?.id : after[field]) !== canonical(expected)) mismatches.push(field);
      }
      const statuses = (await this.client.get('issue_statuses.json')).issue_statuses;
      if (!statuses.some(s => s.id === after.status?.id && (s.is_closed === true) === record.preview.is_closed)) mismatches.push('is_closed');
      result = { state: mismatches.length ? 'verification_failed' : 'applied', issue_id,
        url: this.service.summary(after).url, subject: after.subject, status: after.status, done_ratio: after.done_ratio,
        mismatches, verified_at: new Date().toISOString(), message: mismatches.length ? 'Created, but requested values were not all verified. Do not create another issue.' : 'Issue and selected status verified. Email delivery was not verified.' };
    } catch (error) {
      const rejected = /^HTTP_(401|403|404|409|422|429)$/.test(error.code || '');
      result = { state: started && (issue_id || !rejected) ? 'uncertain' : 'rejected', error: safeError(error),
        ...(issue_id ? { issue_id, url: new URL(`issues/${issue_id}`, this.service.config.baseUrl).href } : {}) };
    }
    try { await this.store.finish(operation_id, result); }
    catch { return { operation_id, state: 'uncertain', ...(issue_id ? { issue_id, url: new URL(`issues/${issue_id}`, this.service.config.baseUrl).href } : {}), message: 'Could not persist result. Do not resend; inspect this operation and Redmine.' }; }
    return { operation_id, ...result };
  }
}
