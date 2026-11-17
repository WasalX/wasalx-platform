# frozen_string_literal: true

require 'json'
require 'digest'
require 'base64'
require 'pathname'

expected_version = ENV.fetch('WASALX_PACKAGE_VERSION')
expected_sha256 = ENV.fetch('WASALX_PACKAGE_SHA256')
package = Package.find_by!(name: 'wasalx')
raise 'WasalX package is not installed' unless package.version == expected_version && package.state == 'installed'

baked_bytes = File.binread(ENV.fetch('WASALX_ZPM_PATH'))
raise 'WasalX baked package digest mismatch' unless Digest::SHA256.hexdigest(baked_bytes) == expected_sha256
baked_archive = JSON.parse(baked_bytes)
unless baked_archive['name'] == 'wasalx' && baked_archive['version'] == expected_version
  raise 'WasalX baked package identity mismatch'
end
stored_archive = JSON.parse(Package._get_bin(package.name, package.version))
unless JSON.generate(stored_archive) == JSON.generate(baked_archive)
  raise 'WasalX stored package content mismatch'
end

application_root = File.expand_path('/opt/zammad')
seen_locations = {}
files = baked_archive.fetch('files')
raise 'WasalX package owns no files' unless files.is_a?(Array) && files.any?
files.each do |entry|
  location = entry.fetch('location')
  permission = entry.fetch('permission')
  content = entry.fetch('content')
  valid_location = location.is_a?(String) && location.match?(/\A[A-Za-z0-9._\/-]+\z/) &&
                   !location.start_with?('/') && Pathname.new(location).cleanpath.to_s == location &&
                   location.split('/').none? { |segment| segment.empty? || segment == '..' }
  raise 'WasalX package contains an unsafe file entry' unless valid_location && permission == '644' && content.is_a?(String)
  raise 'WasalX package contains duplicate file entries' if seen_locations[location]

  seen_locations[location] = true
  expected = Base64.strict_decode64(content)
  raise 'WasalX package contains an empty file' if expected.empty?
  installed = File.expand_path(location, application_root)
  raise 'WasalX package file escapes the application root' unless installed.start_with?("#{application_root}/")
  cursor = application_root
  location.split('/').each do |segment|
    cursor = File.join(cursor, segment)
    raise "WasalX installed package path is a symlink: #{location}" if File.lstat(cursor).symlink?
  end
  resolved = File.realpath(installed)
  raise 'WasalX package file escapes the application root' unless resolved.start_with?("#{application_root}/")
  details = File.lstat(installed)
  raise "WasalX installed package file is unsafe: #{location}" unless details.file? && !details.symlink? && (details.mode & 0o7777) == 0o644
  raise "WasalX installed package file content mismatch: #{location}" unless File.binread(installed) == expected
end

image_archive = JSON.parse(File.binread('/opt/zammad/contrib/wasalx.zpm'))
image_files = image_archive.fetch('files')
raise 'WasalX image package owns no files' unless image_files.is_a?(Array) && image_files.any?
image_locations = image_files.map { |entry| entry.fetch('location') }
stale_locations = image_locations.uniq - seen_locations.keys
stale_locations.each do |location|
  installed = File.expand_path(location, application_root)
  raise 'WasalX image package contains an unsafe file entry' unless installed.start_with?("#{application_root}/")
  raise "WasalX rollback left a stale package file: #{location}" if File.exist?(installed) || File.symlink?(installed)
end

permission = Permission.find_by!(name: 'ticket.agent.wasalx_retry')
raise 'WasalX retry permission is inactive' unless permission.active

article_type = Ticket::Article::Type.find_by!(name: 'wasalx group message')
raise 'WasalX article type is not communicative' unless article_type.active && article_type.communication

base_fields = %w[
  wasalx_reference wasalx_group_id wasalx_group_name wasalx_connection_id
  wasalx_provider wasalx_source_message_id wasalx_correlation_key
  wasalx_latest_external_message_id wasalx_rule_version wasalx_correlation_status
  wasalx_delivery_status wasalx_assignment_mode wasalx_default_priority
  wasalx_sla_policy_id wasalx_business_hours_mode wasalx_business_hours_calendar_id
]
missing_fields = base_fields.reject do |name|
  ObjectManager::Attribute.get(object: 'Ticket', name: name)&.active
end
raise "WasalX ticket fields are missing: #{missing_fields.join(', ')}" if missing_fields.any?
missing_columns = base_fields - Ticket.column_names
raise "WasalX ticket columns are missing: #{missing_columns.join(', ')}" if missing_columns.any?

refresh_migration = 'db/addon/wasalx/202610170001_add_wasalx_session_refresh.rb'
if seen_locations[refresh_migration]
  session_model = ActiveRecord::SessionStore::Session
  session_model.reset_column_information
  refresh_column = session_model.columns_hash['wasalx_oidc_refresh_state']
  unless refresh_column && refresh_column.type == :text && refresh_column.null &&
         refresh_column.default.nil? && refresh_column.default_function.nil?
    raise 'WasalX native refresh storage is unavailable'
  end
end

bot_migration = 'db/addon/wasalx/202608300010_add_direct_conversation_state.rb'
bot_fields = %w[wasalx_bot_conversation wasalx_bot_state]
if seen_locations[bot_migration]
  missing_bot_fields = bot_fields.reject { |name| ObjectManager::Attribute.get(object: 'Ticket', name: name)&.active }
  missing_bot_columns = bot_fields - Ticket.column_names
  raise "WasalX bot fields are missing: #{missing_bot_fields.join(', ')}" if missing_bot_fields.any?
  raise "WasalX bot columns are missing: #{missing_bot_columns.join(', ')}" if missing_bot_columns.any?
end

client_migration = 'db/addon/wasalx/202609010012_materialize_wasalx_client_routing_attributes.rb'
client_fields = %w[
  wasalx_client_routing_version_id wasalx_client_id
  wasalx_client_route_status wasalx_client_route_matched_by
]
if seen_locations[client_migration]
  missing_client_columns = client_fields - Ticket.column_names
  raise "WasalX client-routing columns are missing: #{missing_client_columns.join(', ')}" if missing_client_columns.any?
end

delivery_translation_migration = 'db/addon/wasalx/202609020013_sync_wasalx_delivery_failure_translations.rb'
if seen_locations[delivery_translation_migration]
  delivery_sources = [
    'WasalX delivery is temporarily unavailable. Retry later.',
    'WasalX delivery could not be queued. Contact an administrator.',
  ]
  missing_delivery_translations = delivery_sources.reject do |source|
    target = Translation.find_by(locale: 'ar', source: source)&.target
    target.is_a?(String) && !target.empty? && target != source
  end
  raise "WasalX Arabic delivery translations are missing: #{missing_delivery_translations.join(', ')}" if missing_delivery_translations.any?
end

internal_error_translation_migration = 'db/addon/wasalx/202609190016_sanitize_wasalx_internal_error_translation.rb'
if seen_locations[internal_error_translation_migration]
  source = 'Something went wrong. Received message: %s'
  expected_targets = {
    'en-us' => 'Something went wrong. Go back and try again.',
    'ar'    => 'حدث خطأ ما. ارجع وحاول مرة أخرى.',
  }
  invalid_locales = expected_targets.filter_map do |locale, target|
    translation = Translation.find_source(locale, source)
    locale if translation&.target != target || translation.target_initial == target
  end
  raise "WasalX internal error translations are unsafe: #{invalid_locales.join(', ')}" if invalid_locales.any?
end

hidden_migration = 'db/addon/wasalx/202609020014_hide_wasalx_client_routing_attributes.rb'
if seen_locations[hidden_migration]
  expected_screens = {
    'create' => { '-all-' => { 'shown' => false, 'required' => false } },
    'edit' => { '-all-' => { 'shown' => false, 'required' => false } },
    'view' => { '-all-' => { 'shown' => false } },
  }
  invalid_hidden_fields = client_fields.reject do |name|
    attribute = ObjectManager::Attribute.get(object: 'Ticket', name: name)
    screens = JSON.parse(JSON.generate(attribute&.screens))
    attribute && attribute.active == false && attribute.editable == false && screens == expected_screens &&
      attribute.to_create == false && attribute.to_migrate == false &&
      attribute.to_delete == false && attribute.to_config == false
  end
  raise "WasalX client-routing fields are exposed: #{invalid_hidden_fields.join(', ')}" if invalid_hidden_fields.any?
end

raise 'WasalX frontend package files are not registered' unless Package.app_frontend_files?

puts({
  package: package.name,
  version: package.version,
  baked_package_sha256: expected_sha256,
  source_files_verified: seen_locations.length,
  permission: permission.name,
  article_type: article_type.name,
  ticket_fields: base_fields.length + (seen_locations[bot_migration] ? bot_fields.length : 0) +
    (seen_locations[client_migration] ? client_fields.length : 0),
  frontend_files: true,
}.to_json)
