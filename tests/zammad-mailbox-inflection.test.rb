require 'active_support/inflector'

root = File.expand_path(ARGV.fetch(0))
load File.join(root, 'config/initializers/inflections.rb')
require File.join(root, 'lib/wasalx/required_smtp_tls')

# Native eager loading uses its acronym rules even for explicitly required files.
name = 'wasalx/required_smtp_tls'.camelize
abort 'SMTP TLS module does not match native inflections' unless name == 'Wasalx::RequiredSmtpTLS' && name.constantize.equal?(Wasalx::RequiredSmtpTLS)

puts 'Native mailbox inflection PASS'
