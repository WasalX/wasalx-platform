# Run inside the admitted isolated Zammad container:
# bundle exec rails runner /private/postmaster-ingress.rb < /private/intent.json
# Main validates Compose identity/network and holds the mail-channel lease first.
require 'json'
require 'base64'
require 'digest'
input = JSON.parse(STDIN.read)
raise 'simulation admission missing' unless input.fetch('evidenceMode') == 'simulated' && input.fetch('isolated') == true
raw = Base64.strict_decode64(input.fetch('bytesBase64'))
raise 'message too large' if raw.bytesize > 1_048_576
raise 'MIME hash mismatch' unless Digest::SHA256.hexdigest(raw) == input.fetch('sha256')
channel = Channel.find(input.fetch('channelId'))
raise 'wrong native channel' unless channel.area == 'Email::Account'
parser = Channel::EmailParser.new
parsed = parser.parse(raw)
raise 'message identity mismatch' unless parsed.fetch(:message_id).delete('<>') == input.fetch('messageId').delete('<>')
[:from, :to].each do |key|
  addresses = Mail::AddressList.new(parsed.fetch(key)).addresses
  raise 'non-synthetic address' if addresses.empty? || addresses.any? { |address| address.domain != 'alpha.invalid' }
end
raise 'unexpected cc/bcc' if parsed[:cc].present? || parsed[:bcc].present?
existing = Ticket::Article.where(message_id: parsed.fetch(:message_id)).pluck(:id, :ticket_id)
raise 'retained message requires readback, not replay' unless existing.empty?
receipt = input.fetch('receiptPath')
raise 'private receipt path required' unless receipt.start_with?('/run/wasalx-simulation/') && !receipt.split('/').include?('..')
File.open(receipt, File::WRONLY | File::CREAT | File::EXCL, 0600) do |file|
  file.write(JSON.generate({ state: 'OUTCOME_UNKNOWN', messageId: input.fetch('messageId'), sha256: input.fetch('sha256'), startedAt: Time.now.utc.iso8601 }))
  file.flush
  file.fsync
end
# Installed 7.1.3 MailStdin calls this exact parser entrypoint. No trusted headers.
actual_interface_handle=ApplicationHandleInfo.current
parser.process(channel, raw)
rows = Ticket::Article.where(message_id: parsed.fetch(:message_id)).pluck(:id, :ticket_id)
raise 'expected exactly one parsed article' unless rows.length == 1
result = { state: 'PARSED', messageId: input.fetch('messageId'), sha256: input.fetch('sha256'), articleId: rows[0][0], ticketId: rows[0][1], readbackAt: Time.now.utc.iso8601, ingressEntryPoint:'Channel::EmailParser.process',actorId: Ticket::Article.find(rows[0][0]).created_by_id, interfaceHandle: actual_interface_handle }
File.open(receipt + '.completed', File::WRONLY | File::CREAT | File::EXCL, 0600) { |file| file.write(JSON.generate(result)); file.flush; file.fsync }
puts JSON.generate(result)
