# Native initial-group callback contract; run immediately after package install,
# before the owned compatibility fixture creates any additional groups.
require 'securerandom'
raise 'isolated native fixture required' unless ENV['WASALX_TEST_ISOLATED'] == '1'
raise 'sole-group prerequisite violated' unless Group.count == 1
source = Wasalx::InstalledPackage.verify!
Transaction.execute do
  actor = User.create!(login: "mail-callback-#{SecureRandom.hex(5)}", email: "callback-#{SecureRandom.hex(5)}@example.test",
    firstname: 'Synthetic', lastname: 'Mailbox callback', active: true,
    roles: [Role.find_by!(name: 'Admin'), Role.find_by!(name: 'Agent')], created_by_id: 1, updated_by_id: 1)
  UserInfo.with_user_id(actor.id) do
    group = Group.lock.first!
    # Prepare the nil-sender state within this rollback fixture; never remove groups.
    group.update!(email_address_id: nil, updated_by_id: actor.id)
    managed = Channel.create!(area: 'Email::Account', active: false, group: group, options: {},
      preferences: { 'wasalx_mail_revision' => 1 }, created_by_id: actor.id, updated_by_id: actor.id)
    address = EmailAddress.create!(name: 'Paused synthetic', email: "paused-#{SecureRandom.hex(5)}@example.test",
      channel: managed, created_by_id: actor.id, updated_by_id: actor.id)
    raise 'paused managed draft selected initial sender' unless group.reload.email_address_id.nil?
    address.update!(name: 'Changed paused synthetic', updated_by_id: actor.id)
    raise 'paused managed edit selected initial sender' unless group.reload.email_address_id.nil?
    ordinary = Channel.create!(area: 'Email::Account', active: false, group: group, options: {},
      created_by_id: actor.id, updated_by_id: actor.id)
    baseline = EmailAddress.create!(name: 'Ordinary native callback', email: "ordinary-#{SecureRandom.hex(5)}@example.test",
      channel: ordinary, created_by_id: actor.id, updated_by_id: actor.id)
    raise 'ordinary native callback was suppressed' unless group.reload.email_address_id == baseline.id
  end
  raise ActiveRecord::Rollback
end
puts JSON.generate(mode: 'isolated-native-sole-group', source: source,
  proof: ['managed-paused-create-and-edit-preserve-nil-sender', 'ordinary-native-callback-retained'])
