# frozen_string_literal: true

require 'json'
require 'ipaddr'
require 'pathname'

def required_environment(name, minimum: 1, maximum: 4096)
  value = ENV.fetch(name, '')
  abort("WASALX_ZAMMAD_BOOTSTRAP_CONFIGURATION_INVALID:#{name}") if value.length < minimum || value.length > maximum || value.match?(/[\u0000\r\n]/)

  value
end

def external_authority!
  value = required_environment('ZAMMAD_FQDN', maximum: 259)
  abort('WASALX_ZAMMAD_BOOTSTRAP_CONFIGURATION_INVALID:ZAMMAD_FQDN') if value.match?(/[\s\/?#@\\]/)

  if value.start_with?('[')
    match = /\A\[([^\]]+)\](?::([0-9]+))?\z/.match(value)
    begin
      valid_host = match && IPAddr.new(match[1]).ipv6?
    rescue IPAddr::InvalidAddressError
      valid_host = false
    end
    port = match && match[2]
  else
    parts = value.split(':', -1)
    abort('WASALX_ZAMMAD_BOOTSTRAP_CONFIGURATION_INVALID:ZAMMAD_FQDN') if parts.length > 2
    host, port = parts
    begin
      valid_host = IPAddr.new(host).ipv4?
    rescue IPAddr::InvalidAddressError
      valid_host = host.length <= 253 && host.split('.').all? do |label|
        label.match?(/\A[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\z/i)
      end
    end
  end

  valid_port = port.nil? || (port.match?(/\A[0-9]+\z/) && port.to_i.between?(1, 65_535))
  abort('WASALX_ZAMMAD_BOOTSTRAP_CONFIGURATION_INVALID:ZAMMAD_FQDN') unless valid_host && valid_port

  value
end

def reconcile_token!(user:, name:, value:, permissions:)
  collision = Token.find_by(action: 'api', token: value)
  abort('WASALX_ZAMMAD_BOOTSTRAP_TOKEN_COLLISION') if collision &&
                                                       (collision.user_id != user.id || collision.name != name)

  token = Token.find_or_initialize_by(action: 'api', persistent: true, user_id: user.id, name: name)
  token.preferences = { permission: permissions }
  token.expires_at = nil
  token.save!
  token.update_columns(token: value, updated_at: Time.current) if token.token != value

  verified = Token.find_by(action: 'api', persistent: true, user_id: user.id, name: name, token: value)
  verified_permissions = verified && (verified.preferences[:permission] || verified.preferences['permission'])
  abort('WASALX_ZAMMAD_BOOTSTRAP_TOKEN_VERIFY_FAILED') unless Array(verified_permissions).sort == permissions.sort
end

# Resolve ownership before reading/reconciling a human bootstrap password. A
# missing receipt with machine evidence is an error, never a legacy fallback.
service_identity = Wasalx::ServiceIdentity
handover_path = ENV.fetch('WASALX_SERVICE_IDENTITY_INPUT_PATH', '')
if !handover_path.empty? || service_identity.handover_evidence?
  secrets = {
    'runtime' => required_environment('ZAMMAD_SERVICE_TOKEN', minimum: 16),
    'privacy' => required_environment('ZAMMAD_PRIVACY_TOKEN', minimum: 16),
  }
  if handover_path.empty?
    record = service_identity.receipt
    raise service_identity::Conflict, 'Service identity receipt is missing' unless record
    service_identity.verify_startup!(record, secrets: secrets)
    Wasalx::InstalledPackage.verify!
  else
    raise service_identity::Conflict, 'Handover input is outside the governed mount' unless handover_path == '/run/wasalx/handover/input.json'
    input = File.binread(handover_path)
    raise service_identity::Conflict, 'Handover input is too large' if input.bytesize > 16_384
    service_identity.transition!(JSON.parse(input), secrets: secrets)
  end
  # Native settings below remain owned by the existing setup job. No owner,
  # password, OIDC user binding, token value or human group grant is rewritten.
  load Rails.root.join('lib/wasalx/bootstrap_settings.rb')
  Wasalx::BootstrapSettings.apply!
  puts 'WASALX_ZAMMAD_BOOTSTRAP_OK'
  exit
end
service_identity.legacy_bootstrap_allowed!

oidc_subject = required_environment('WASALX_ZAMMAD_BOOTSTRAP_OIDC_SUBJECT', maximum: 250) if ENV.key?('WASALX_ZAMMAD_BOOTSTRAP_OIDC_SUBJECT')
bootstrap_email = required_environment('WASALX_ZAMMAD_BOOTSTRAP_EMAIL', maximum: 320)
bootstrap_name = required_environment('WASALX_ZAMMAD_BOOTSTRAP_NAME', maximum: 120)
bootstrap_password = required_environment('WASALX_ZAMMAD_BOOTSTRAP_PASSWORD', minimum: 16)
service_token = required_environment('ZAMMAD_SERVICE_TOKEN', minimum: 16)
privacy_token = required_environment('ZAMMAD_PRIVACY_TOKEN', minimum: 16)
http_type = required_environment('ZAMMAD_HTTP_TYPE', maximum: 5)
abort('WASALX_ZAMMAD_BOOTSTRAP_CONFIGURATION_INVALID:ZAMMAD_HTTP_TYPE') unless %w[http https].include?(http_type)
fqdn = external_authority!
agent_keys = %w[WASALX_ZAMMAD_AGENT_EMAIL WASALX_ZAMMAD_AGENT_NAME WASALX_ZAMMAD_AGENT_PASSWORD]
agent_values = agent_keys.map { |name| ENV.fetch(name, '') }
abort('WASALX_ZAMMAD_BOOTSTRAP_AGENT_CONFIGURATION_INCOMPLETE') if agent_values.any?(&:empty?) && agent_values.any? { |value| !value.empty? }
agent_email, agent_name, agent_password = if agent_values.all? { |value| !value.empty? }
                                            [
                                              required_environment('WASALX_ZAMMAD_AGENT_EMAIL', maximum: 320),
                                              required_environment('WASALX_ZAMMAD_AGENT_NAME', maximum: 120),
                                              required_environment('WASALX_ZAMMAD_AGENT_PASSWORD', minimum: 16),
                                            ]
                                          end
if agent_email
  abort('WASALX_ZAMMAD_BOOTSTRAP_IDENTITIES_NOT_DISTINCT') if agent_email.casecmp?(bootstrap_email) || agent_password == bootstrap_password
end
previous_email = if ENV.fetch('WASALX_ZAMMAD_BOOTSTRAP_PREVIOUS_EMAIL', '').empty?
                   nil
                 else
                   required_environment('WASALX_ZAMMAD_BOOTSTRAP_PREVIOUS_EMAIL', maximum: 320)
                 end

owner = User.find_by(email: bootstrap_email)
unless owner
  migration_emails = [previous_email, agent_email].compact.uniq
  admin_candidates = User.where(email: migration_emails, active: true).select { |user| user.permissions?('admin') }.uniq(&:id)
  abort('WASALX_ZAMMAD_BOOTSTRAP_OWNER_AMBIGUOUS') if admin_candidates.length > 1
  owner = admin_candidates.first
end

# A receipt and both account markers being lost must still not move an existing
# integration credential back from a different principal by matching an email.
%w[ZAMMAD_SERVICE_TOKEN ZAMMAD_PRIVACY_TOKEN].each do |key|
  existing_token = Token.find_by(action: 'api', token: ENV.fetch(key))
  abort('WASALX_ZAMMAD_BOOTSTRAP_TOKEN_OWNER_CHANGED') if existing_token && (!owner || existing_token.user_id != owner.id)
end


fresh_database = Setting.find_by!(name: 'system_init_done').state_current.to_h.with_indifferent_access[:value] != true
run_bootstrap = lambda do
if fresh_database
  first_name, last_name = bootstrap_name.split(/\s+/, 2)
  last_name = 'Owner' if last_name.to_s.empty?
  display_timezone = ENV.fetch('WASALX_ZAMMAD_DISPLAY_TIMEZONE', '')
  display_timezone = 'Asia/Riyadh' if display_timezone.empty?
  wizard_relative_path = ENV.fetch('AUTOWIZARD_RELATIVE_PATH', 'tmp/auto_wizard.json')
  abort('WASALX_ZAMMAD_BOOTSTRAP_WIZARD_PATH_INVALID') if Pathname.new(wizard_relative_path).absolute? || wizard_relative_path.split('/').include?('..')
  wizard_path = Rails.root.join(wizard_relative_path)
  wizard = JSON.generate(
      Users: [{ login: bootstrap_email, firstname: first_name, lastname: last_name, email: bootstrap_email, password: bootstrap_password }],
      Groups: [{ name: 'Operations', users: [bootstrap_email] }],
      Settings: [
        { name: 'timezone_default', value: display_timezone },
        { name: 'product_name', value: 'WasalX Support' },
      ],
  )
  File.open(wizard_path, File::WRONLY | File::CREAT | File::TRUNC, 0o600) { |file| file.write(wizard) }
  begin
    # The rake wrapper links into Rails.root, which is read-only in production.
    ENV['AUTOWIZARD_RELATIVE_PATH'] = wizard_relative_path
    Rails.cache.clear
    AutoWizard.setup
    sample_customer = User.find_by(email: 'nicole.braun@zammad.org')
    if sample_customer
      Ticket.where(customer_id: sample_customer.id).find_each(&:destroy!)
      sample_customer.update!(active: false)
    end
    Setting.set('system_init_done', true)
  ensure
    File.delete(wizard_path) if File.exist?(wizard_path)
  end
end


owner = User.find_by(email: bootstrap_email)
unless owner
  migration_emails = [previous_email, agent_email].compact.uniq
  admin_candidates = User.where(email: migration_emails, active: true).select { |user| user.permissions?('admin') }.uniq(&:id)
  abort('WASALX_ZAMMAD_BOOTSTRAP_OWNER_AMBIGUOUS') if admin_candidates.length > 1
  owner = admin_candidates.first
end
abort('WASALX_ZAMMAD_BOOTSTRAP_OWNER_MISSING') unless owner&.active? && owner.permissions?('admin')

Authorization.transaction do
  owner.lock!
  if oidc_subject
    abort('WASALX_ZAMMAD_BOOTSTRAP_OIDC_AUTO_LINK_ENABLED') unless Setting.get('auth_third_party_auto_link_at_inital_login') == false
    bindings = Authorization.where(provider: 'openid_connect', uid: oidc_subject).lock.to_a
    abort('WASALX_ZAMMAD_BOOTSTRAP_OIDC_SUBJECT_CONFLICT') unless bindings.empty? || (bindings.one? && bindings.first.user_id == owner.id)
    abort('WASALX_ZAMMAD_BOOTSTRAP_OIDC_OWNER_CONFLICT') if Authorization.where(user_id: owner.id, provider: 'openid_connect').where.not(uid: oidc_subject).exists?
    if bindings.empty?
      abort('WASALX_ZAMMAD_BOOTSTRAP_OIDC_NOTIFICATION_ENABLED') unless Setting.get('auth_third_party_linking_notification') == false
    end
  end

  first_name, last_name = bootstrap_name.split(/\s+/, 2)
  last_name = 'Owner' if last_name.to_s.empty?
  owner.update!(
    login: bootstrap_email,
    email: bootstrap_email,
    firstname: first_name,
    lastname: last_name,
    active: true,
    verified: true,
    password: bootstrap_password,
    login_failed: 0,
  )
  Auth.new(owner.login, bootstrap_password, only_verify_password: true).valid!
  owner.reload
  abort('WASALX_ZAMMAD_BOOTSTRAP_OWNER_RECONCILE_FAILED') unless owner.verified == true && owner.permissions?('admin') && owner.permissions?('ticket.agent')

  if oidc_subject
    Authorization.create!(user: owner, provider: 'openid_connect', uid: oidc_subject, username: oidc_subject) if bindings.empty?
    binding = Authorization.find_by!(provider: 'openid_connect', uid: oidc_subject)
    abort('WASALX_ZAMMAD_BOOTSTRAP_OIDC_VERIFY_FAILED') unless binding.user_id == owner.id
  end
end
UserInfo.current_user_id = owner.id

if agent_email
  agent_role = Role.find_by(name: 'Agent')
  operations = Group.find_by(name: 'Operations')
  abort('WASALX_ZAMMAD_BOOTSTRAP_AGENT_ROLE_MISSING') unless agent_role&.active? && agent_role.with_permission?('ticket.agent')
  abort('WASALX_ZAMMAD_BOOTSTRAP_AGENT_GROUP_MISSING') unless operations&.active?

  agent_first, agent_last = agent_name.split(/\s+/, 2)
  agent_last = 'Agent' if agent_last.to_s.empty?
  agent = User.find_or_initialize_by(email: agent_email)
  agent.created_by_id ||= owner.id
  agent.update!(
    login: agent_email,
    email: agent_email,
    firstname: agent_first,
    lastname: agent_last,
    active: true,
    verified: true,
    password: agent_password,
    login_failed: 0,
    updated_by_id: owner.id,
    role_ids: [agent_role.id],
  )
  agent.group_ids_access_map = { operations.id => 'full' }
  Auth.new(agent.login, agent_password, only_verify_password: true).valid!
  agent.reload
  admin_grants = agent.permissions.pluck(:name).grep(/\Aadmin(?:\.|\z)/)
  valid_agent = agent.id != owner.id &&
                agent.role_ids.sort == [agent_role.id] &&
                agent.permissions?('ticket.agent') &&
                !agent.permissions?('admin') && admin_grants.empty? &&
                agent.group_ids_access_map == { operations.id => ['full'] } &&
                agent.group_ids_access(%w[read create change overview]).sort == [operations.id]
  abort('WASALX_ZAMMAD_BOOTSTRAP_AGENT_RECONCILE_FAILED') unless valid_agent
end

{
  'product_name' => 'WasalX Support',
  'user_create_account' => false,
  'http_type' => http_type,
  'fqdn' => fqdn,
}.each do |name, value|
  abort("WASALX_ZAMMAD_BOOTSTRAP_SETTING_MISSING:#{name}") unless Setting.exists?(name: name)

  Setting.set(name, value)
  abort("WASALX_ZAMMAD_BOOTSTRAP_SETTING_RECONCILE_FAILED:#{name}") unless Setting.get(name) == value
end

reconcile_token!(
  user: owner,
  name: 'WasalX Service',
  value: service_token,
  permissions: %w[admin.calendar admin.group admin.package admin.security admin.sla admin.system admin.user ticket.agent],
)
reconcile_token!(user: owner, name: 'WasalX Privacy', value: privacy_token, permissions: %w[admin.data_privacy])

if fresh_database && ENV.fetch('WASALX_SERVICE_IDENTITY_MODE', '') == 'fresh'
  abort('WASALX_ZAMMAD_BOOTSTRAP_FRESH_OWNER_SUBJECT_MISSING') unless oidc_subject
  service_identity.provision_fresh!(owner: owner, subject: oidc_subject, email: bootstrap_email,
    secrets: { 'runtime' => service_token, 'privacy' => privacy_token })
end

abort('WASALX_ZAMMAD_BOOTSTRAP_INIT_VERIFY_FAILED') unless Setting.get('system_init_done') == true

load Rails.root.join('lib/wasalx/bootstrap_settings.rb')
Wasalx::BootstrapSettings.apply!
Rails.cache.clear
end
# Keep first initialization and machine binding atomic across a lost process.
if fresh_database && ENV.fetch('WASALX_SERVICE_IDENTITY_MODE', '') == 'fresh'
  Transaction.execute(&run_bootstrap)
else
  run_bootstrap.call
end
puts 'WASALX_ZAMMAD_BOOTSTRAP_OK'
