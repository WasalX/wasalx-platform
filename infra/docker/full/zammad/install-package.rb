# frozen_string_literal: true

require 'digest'
require 'json'
require 'base64'
require 'pathname'

artifact = ENV.fetch('WASALX_ZPM_PATH', '/opt/zammad/contrib/wasalx.zpm')
expected_name = 'wasalx'
expected_version = ENV.fetch('WASALX_PACKAGE_VERSION')
expected_sha256 = ENV.fetch('WASALX_PACKAGE_SHA256')

raise 'WasalX package digest mismatch' unless Digest::SHA256.file(artifact).hexdigest == expected_sha256

metadata = JSON.parse(File.read(artifact))
unless metadata['name'] == expected_name && metadata['version'] == expected_version
  raise 'WasalX package identity mismatch'
end

installed = Package.find_by(name: expected_name)

boundary_transition = installed && %w[0.5.42 0.5.44 0.5.45].any? { |boundary|
  (Gem::Version.new(installed.version) <= Gem::Version.new(boundary)) != (Gem::Version.new(expected_version) <= Gem::Version.new(boundary))
}
same_version_incomplete = false
if installed && installed.version == expected_version && Gem::Version.new(expected_version) >= Gem::Version.new('0.5.43')
  raise 'WasalX package migration preflight is unavailable' unless defined?(Package::Migration)

  begin
    same_version_incomplete = !Package::Migration.exists?(name: expected_name, version: '202609020015')
  rescue StandardError
    raise 'WasalX package migration preflight is unavailable', cause: nil
  end
end

if boundary_transition || same_version_incomplete
  raise 'WasalX routing queue preflight is unavailable' if !defined?(Delayed::Job)

  begin
    legacy_routing_jobs = Delayed::Job.where('handler LIKE ?', '%WasalxTicketRoutingJob%').exists?
  rescue StandardError
    raise 'WasalX routing queue preflight is unavailable', cause: nil
  end
  raise 'WasalX routing jobs must finish before package transition' if legacy_routing_jobs
end

# The immutable image contains current package files before Package.install.
# Reconcile only proven package-owned bytes before Zammad can create backup
# files or discover addon migrations from the wrong package revision.
def package_files(archive, expected_name)
  raise 'WasalX package ownership record is invalid' unless archive['name'] == expected_name && archive['files'].is_a?(Array)
  archive['files'].each_with_object({}) do |entry, files|
    location = entry['location']
    valid = location.is_a?(String) && location.match?(/\A[A-Za-z0-9._\/-]+\z/) &&
            !location.start_with?('/') && Pathname.new(location).cleanpath.to_s == location &&
            location.split('/').none? { |segment| segment.empty? || segment == '..' }
    raise 'WasalX package ownership record is invalid' unless valid && entry['permission'] == '644' && entry['content'].is_a?(String) && !files.key?(location)
    bytes = Base64.strict_decode64(entry['content'])
    raise 'WasalX package ownership record is invalid' if bytes.empty?
    files[location] = bytes
  rescue ArgumentError
    raise 'WasalX package ownership record is invalid'
  end
end

application_root = File.expand_path(defined?(Rails) ? Rails.root.to_s : ENV.fetch('WASALX_ZAMMAD_ROOT', '/opt/zammad'))
raise 'WasalX application root is invalid' unless Pathname.new(application_root).absolute? && File.directory?(application_root) && !File.lstat(application_root).symlink?

def package_path(application_root, location)
  path = File.expand_path(location, application_root)
  raise 'WasalX package ownership path escapes the application root' unless path.start_with?("#{application_root}/")

  cursor = application_root
  location.split('/').each do |segment|
    cursor = File.join(cursor, segment)
    next unless File.exist?(cursor) || File.symlink?(cursor)
    raise "WasalX package path is a symlink: #{location}" if File.lstat(cursor).symlink?
  end
  path
end

target_files = package_files(metadata, expected_name)
baked_archive = File.binread(File.join(application_root, 'contrib', 'wasalx.zpm'))
baked_metadata = JSON.parse(baked_archive)
if baked_metadata['version'] == expected_version && File.binread(artifact) != baked_archive
  raise 'WasalX same-version package differs from the immutable image artifact'
end
ownership = package_files(baked_metadata, expected_name)
installed_files = {}
if installed
  installed_metadata = JSON.parse(Package._get_bin(installed.name, installed.version))
  unless installed_metadata['name'] == installed.name && installed_metadata['version'] == installed.version
    raise 'WasalX stored package identity mismatch'
  end
  if installed.version == expected_version && JSON.generate(installed_metadata) != JSON.generate(metadata)
    raise 'WasalX same-version package differs from the stored artifact'
  end
  installed_files = package_files(installed_metadata, expected_name)
  installed_files.each do |location, bytes|
    ownership[location] ||= bytes
  end
end

exact_install_mismatch = installed && installed.version == expected_version && installed.state == 'installed' && target_files.any? do |location, expected|
  path = package_path(application_root, location)
  !File.file?(path) || File.lstat(path).symlink? || (File.lstat(path).mode & 0o7777) != 0o644 || File.binread(path) != expected
end
install_required = installed.nil? || installed.version != expected_version || installed.state != 'installed' || exact_install_mismatch
# Production registers the exact baked archive without rewriting immutable files.
# Different-version archives are used only by the existing writable compatibility
# harness, which still exercises native file replacement below.
immutable = File.binread(artifact) == baked_archive
native_methods = {}
if immutable
  verify_immutable_file = lambda do |location|
    path = package_path(application_root, location)
    backup = package_path(application_root, "#{location}.save")
    raise "WasalX immutable package backup exists: #{location}" if File.exist?(backup) || File.symlink?(backup)
    if target_files.key?(location)
      raise "WasalX immutable package file mismatch: #{location}" unless File.file?(path) &&
        (File.lstat(path).mode & 0o7777) == 0o644 && File.binread(path) == target_files.fetch(location)
    else
      raise "WasalX immutable package stale file exists: #{location}" if File.exist?(path) || File.symlink?(path)
    end
  end
  ownership.each_key { |location| verify_immutable_file.call(location) }
  %i[_write_file _delete_file].each do |name|
    method = Package.method(name)
    raise 'WasalX native package file contract changed' unless method.arity == 3
    if defined?(Rails)
      source = File.join(application_root, 'app/models/package.rb')
      unless method.source_location&.first == source &&
          Digest::SHA256.file(source).hexdigest == 'd677d34ed6154d7a16c16933640af9066460a805f108ca524b6aacdc2d705d44'
        raise 'WasalX native package file contract changed'
      end
    end
    native_methods[name] = method
  end
end
removals = immutable ? [] : (install_required ? ownership.keys : ownership.keys - target_files.keys)
removal_paths = removals.filter_map do |location|
  path = package_path(application_root, location)
  next unless File.exist?(path) || File.symlink?(path)
  details = File.lstat(path)
  raise "WasalX stale package file is unsafe: #{location}" unless details.file? && !details.symlink?
  actual = File.binread(path)
  owned_bytes = [ownership[location], installed_files[location]].compact
  raise "WasalX stale package file was modified: #{location}" unless owned_bytes.include?(actual)
  path
end
removal_paths.each { |path| File.delete(path) }

begin
  if immutable
    # One-shot, pinned compatibility adapter; no Zammad core files are changed.
    # Keep native dependency, duplicate-file, transaction, Store and state logic.
    Package.define_singleton_method(:_write_file) do |location, permission, data|
      unless target_files.key?(location) && permission.to_s == '644' && data == target_files.fetch(location)
        raise 'WasalX unexpected immutable package write'
      end
      verify_immutable_file.call(location)
      true
    end
    Package.define_singleton_method(:_delete_file) do |location, permission, data|
      unless installed_files.key?(location) && permission.to_s == '644' && data == installed_files.fetch(location)
        raise 'WasalX unexpected immutable package delete'
      end
      verify_immutable_file.call(location)
      true
    end
  end

  if installed.nil?
    installed = Package.install(file: artifact)
  elsif Gem::Version.new(installed.version) < Gem::Version.new(expected_version)
    installed = Package.install(file: artifact)
  elsif installed.version != expected_version
    # Zammad's reinstall path deliberately keeps the existing package record and
    # stored artifact. Replace the record through the public package API when an
    # older image is intentionally restored so verification sees the baked
    # rollback artifact, while retaining additive database migrations.
    Package.uninstall(
      name: installed.name,
      version: installed.version,
      migration_not_down: true,
    )
    installed = Package.install(file: artifact)
  elsif installed.state != 'installed'
    installed = Package.install(file: artifact, reinstall: true)
  elsif exact_install_mismatch
    installed = Package.install(file: artifact, reinstall: true)
  end

ensure
  native_methods.each { |name, method| Package.define_singleton_method(name, method) }
end

raise 'WasalX stored package content mismatch' unless JSON.generate(JSON.parse(Package._get_bin(installed.name, installed.version))) == JSON.generate(metadata)

# This runs before zammad:package:migrate. A target-only filesystem prevents a
# current-image migration from contaminating predecessor qualification.
target_files.each do |location, expected|
  path = package_path(application_root, location)
  details = File.lstat(path)
  raise "WasalX target package file is unsafe: #{location}" unless details.file? && !details.symlink? && (details.mode & 0o7777) == 0o644
  raise "WasalX target package file content mismatch: #{location}" unless File.binread(path) == expected
end
(ownership.keys - target_files.keys).each do |location|
  path = package_path(application_root, location)
  raise "WasalX target install left a stale package file: #{location}" if File.exist?(path) || File.symlink?(path)
end

puts({ package: installed.name, version: installed.version, state: installed.state }.to_json)
