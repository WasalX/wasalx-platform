# frozen_string_literal: true
require 'minitest/autorun'
require 'ostruct'
require 'monitor'
require 'securerandom'

package_root = ENV.fetch('WASALX_TEST_PACKAGE_ROOT', File.expand_path('../../zammad-package', __dir__))
load File.join(package_root, 'lib/wasalx/session_assurance.rb') unless defined?(Wasalx::SessionAssurance)
load File.join(package_root, 'lib/wasalx/session_refresh.rb') unless defined?(Wasalx::SessionRefresh)
load File.join(package_root, 'lib/wasalx/session_state.rb') unless defined?(Wasalx::SessionState)

# Dependency-method fixture, not a Rails/image/provider integration claim.
# Exact captured store and OIDC method bodies are injected below. Persistence
# supplies independent row snapshots, transactional rollback and a short lock.
class NativeStateRow
  class << self
    attr_accessor :records, :next_id, :fail_save, :fail_lock, :refuse_save
    def copy(value); Marshal.load(Marshal.dump(value)); end
    def transaction
      (@mutex ||= Monitor.new).synchronize do
        previous = copy(records)
        Thread.current[:native_state_fixture_transaction] = true
        begin; yield
        rescue StandardError; self.records = previous; raise
        ensure; Thread.current[:native_state_fixture_transaction] = false
        end
      end
    end
    def connection; self; end
    def logger; nil; end
    def transaction_open?; !!Thread.current[:native_state_fixture_transaction]; end
    def uncached; yield; end
    def lock; raise 'private database failure' if fail_lock; self; end
    def find_by(session_id:); find_by_session_id(session_id); end
    def find_by_session_id(reference)
      value = records[reference]
      new(session_id: reference, data: copy(value[:data]), id: value[:id]) if value
    end
  end
  attr_accessor :session_id, :data
  attr_reader :id
  def initialize(session_id:, data:, id: nil)
    @session_id, @data, @id = session_id, data, id
  end
  def save
    raise 'private save failure' if self.class.fail_save
    return false if self.class.refuse_save
    @id ||= self.class.next_id += 1
    self.class.records[session_id] = { id: @id, data: self.class.copy(data) }
    true
  end
  def save!; raise 'private save refused' unless save; true; end
  def destroy; self.class.records.delete(session_id); end
end
NativeStateSid = Struct.new(:public_id) do
  def private_id; "private-#{public_id}"; end
end
NativeStateRequest = Struct.new(:env)
class NativeStateOptions < Hash
  def id(_request); self[:id]; end
end
class NativeStateStore
  SESSION_RECORD_KEY = 'rack.session.record'
  ENV_SESSION_OPTIONS_KEY = 'rack.session.options'
  module Quiet
    def self.silence; yield; end
  end
  def self.private_session_id?(_id); false; end
  def self.session_class; NativeStateRow; end
  def session_class; NativeStateRow; end
  def logger; Quiet; end
  def generate_sid; NativeStateSid.new(SecureRandom.hex(16)); end
  def current_session_id(request); request.env['rack.session'].id; end
      def write_session(request, sid, session_data, options)
        logger.silence do
          record, sid = get_session_model(request, sid)
          record.data = session_data
          return false unless record.save

          session_data = record.data
          if session_data && session_data.respond_to?(:each_value)
            session_data.each_value do |obj|
              obj.clear_association_cache if obj.respond_to?(:clear_association_cache)
            end
          end

          sid
        end
      end

      def delete_session(request, session_id, options)
        logger.silence do
          if sid = current_session_id(request)
            if model = get_session_with_fallback(sid)
              data = model.data
              model.destroy
            end
          end

          request.env[SESSION_RECORD_KEY] = nil

          unless options[:drop]
            new_sid = generate_sid

            if options[:renew]
              new_model = session_class.new(:session_id => new_sid.private_id, :data => data)
              new_model.save
              request.env[SESSION_RECORD_KEY] = new_model
            end
            new_sid
          end
        end
      end

      def get_session_model(request, id)
        logger.silence do
          model = get_session_with_fallback(id)
          unless model
            id = generate_sid
            model = session_class.new(:session_id => id.private_id, :data => {})
            model.save
          end
          if request.env[ENV_SESSION_OPTIONS_KEY][:id].nil?
            request.env[SESSION_RECORD_KEY] = model
          else
            request.env[SESSION_RECORD_KEY] ||= model
          end
          [model, id]
        end
      end

      def get_session_with_fallback(sid)
        if sid && !self.class.private_session_id?(sid.public_id)
          if (secure_session = session_class.find_by_session_id(sid.private_id))
            secure_session
          elsif (insecure_session = session_class.find_by_session_id(sid.public_id))
            insecure_session.session_id = sid.private_id # this causes the session to be secured
            insecure_session
          end
        end
      end

      def find_session(request, id)
        model, id = get_session_model(request, id)
        [id, model.data]
      end

end

class NativeStateSession
  def initialize(store, request, sid, data, loaded: true)
    @by, @req, @delegate, @loaded = store, request, data, loaded
    options[:id] = sid
  end
  def options; @req.env['rack.session.options']; end
  def id; options.id(@req); end
  def enabled?; true; end
  def loaded?; @loaded; end
  def [](key); load_for_write!; @delegate[key.to_s]; end
  def []=(key, value); load_for_write!; @delegate[key.to_s] = value; end
  def delete(key); load_for_write!; @delegate.delete(key.to_s); end
  def to_hash; load_for_write!; @delegate.dup; end
  def clear; load_for_write!; @delegate.clear; end
  def load_for_write!; load! unless loaded?; end
  def load!
    sid, data = @by.send(:find_session, @req, options.id(@req))
    options[:id] = sid
    @delegate = data.dup
    @loaded = true
  end
      def destroy
        clear

        if enabled?
          options = self.options || {}
          @by.send(:delete_session, @req, options.id(@req), options)

          # Load the new sid to be written with the response.
          @loaded = false
          load_for_write!
        end
      end

end

# The accepted refresh module is already prepended when the state guard is
# included: this exercises the reload/upgrade order, then fresh-class order.
NativeStateRefreshConcern = Wasalx::SessionRefresh::Store.dup
class NativeStatePreviouslyInstalledStore < NativeStateStore
  prepend NativeStateRefreshConcern
end
NativeStateRefreshConcern.include(Wasalx::SessionState::Store)
class NativeStateFreshStore < NativeStateStore
  prepend NativeStateRefreshConcern
end
NativeStateAssuranceConcern = Wasalx::SessionAssurance::OidcVerification.dup
NativeStateAssuranceConcern.include(Wasalx::SessionState::Oidc)

module Rack
  module OAuth2
    class Client
      class Error < StandardError; end
    end
  end
end
module OmniAuth
  def self.config; @native_state_config ||= OpenStruct.new(before_callback_phase: nil); end
end
class NativeStateCallbackBase
  def callback_phase; :accepted; end
end
class NativeStatePinnedStrategy < NativeStateCallbackBase
  attr_reader :env, :options, :provider_calls
  def initialize(request, params = {}, nonce: nil, verifier: nil)
    @env, @params, @expected_nonce, @expected_verifier = request.env, params, nonce, verifier
    @options = OpenStruct.new(send_state: true, require_state: true, issuer: 'https://identity.example.test', state: nil)
    @provider_calls = 0
  end
  def params; @params; end
  def session; env['rack.session']; end
  def setup_phase; end
  def log(*); end
  def valid_response_type?; true; end
  def configured_response_type; 'code'; end
  def discover!; raise 'lock across provider discovery' if NativeStateRow.transaction_open?; end
  def client; @client ||= OpenStruct.new; end
  def redirect_uri; 'https://native.example.test/auth/openid_connect/callback'; end
  def authorization_code; params['code']; end
  def fail!(kind, _exception); kind; end
  def access_token
    raise 'lock across provider exchange' if NativeStateRow.transaction_open?
    @provider_calls += 1
    raise 'nonce rejected' unless stored_nonce == @expected_nonce
    raise 'PKCE rejected' unless session.delete('omniauth.pkce.verifier') == @expected_verifier
    :provider_response
  end
  def request_phase
    discover!
    session['omniauth.params'] = { 'fingerprint' => 'synthetic-browser' }
    session['omniauth.origin'] = '/desktop/login'
    new_nonce
    new_state
    session['omniauth.pkce.verifier'] = SecureRandom.hex(32)
    [302, { 'location' => "https://identity.example.test/authorize?state=#{session['omniauth.state']}" }, []]
  end
      def callback_phase
        error = params['error_reason'] || params['error']
        error_description = params['error_description'] || params['error_reason']
        invalid_state =
          if options.send_state
            (options.require_state && params['state'].to_s.empty?) || params['state'] != stored_state
          else
            false
          end

        raise CallbackError, error: params['error'], reason: error_description, uri: params['error_uri'] if error
        raise CallbackError, error: :csrf_detected, reason: "Invalid 'state' parameter" if invalid_state

        return unless valid_response_type?

        options.issuer = issuer if options.issuer.nil? || options.issuer.empty?

        verify_id_token!(params['id_token']) if configured_response_type == 'id_token'
        discover!
        client.redirect_uri = redirect_uri

        return id_token_callback_phase if configured_response_type == 'id_token'

        client.authorization_code = authorization_code
        access_token
        super
      rescue CallbackError => e
        fail!(e.error, e)
      rescue ::Rack::OAuth2::Client::Error => e
        fail!(e.response[:error], e)
      rescue ::Timeout::Error, ::Errno::ETIMEDOUT => e
        fail!(:timeout, e)
      rescue ::SocketError => e
        fail!(:failed_to_connect, e)
      end

      def new_state
        state = if options.state.respond_to?(:call)
                  if options.state.arity == 1
                    options.state.call(env)
                  else
                    options.state.call
                  end
                end
        session['omniauth.state'] = state || SecureRandom.hex(16)
      end

      def stored_state
        session.delete('omniauth.state')
      end

      def new_nonce
        session['omniauth.nonce'] = SecureRandom.hex(16)
      end

      def stored_nonce
        session.delete('omniauth.nonce')
      end

      class CallbackError < StandardError
        attr_accessor :error, :error_reason, :error_uri

        def initialize(data)
          super
          self.error = data[:error]
          self.error_reason = data[:reason]
          self.error_uri = data[:uri]
        end

        def message
          [error, error_reason, error_uri].compact.join(' | ')
        end
      end

    def callback_call
      setup_phase
      log :debug, 'Callback phase initiated.'
      @env['omniauth.origin'] = session.delete('omniauth.origin')
      @env['omniauth.origin'] = nil if env['omniauth.origin'] == ''
      @env['omniauth.params'] = session.delete('omniauth.params') || {}
      OmniAuth.config.before_callback_phase.call(@env) if OmniAuth.config.before_callback_phase
      callback_phase
    end

end
class NativeStateStrategy < NativeStatePinnedStrategy
  prepend NativeStateAssuranceConcern
end

class NativeSessionStateContract < Minitest::Test
  ENROLL = Wasalx::SessionRefresh.method(:enroll!)
  ROWS = Wasalx::SessionState.method(:rows)
  def setup
    NativeStateRow.records, NativeStateRow.next_id = {}, 0
    NativeStateRow.fail_save = NativeStateRow.fail_lock = false
    NativeStateRow.refuse_save = false
    @store = NativeStateFreshStore.new
    @id = NativeStateSid.new('synthetic-browser')
    NativeStateRow.new(session_id: @id.private_id, data: { 'ping' => 'before', '_csrf_token' => 'csrf-original' }).save!
    @enrollments = 0
    fixture = self
    counter = ->(*) { fixture.instance_variable_set(:@enrollments, fixture.instance_variable_get(:@enrollments) + 1); true }
    Wasalx::SessionRefresh.define_singleton_method(:enroll!, &counter)
    Wasalx::SessionState.define_singleton_method(:rows) { NativeStateRow }
  end
  def teardown
    Wasalx::SessionRefresh.define_singleton_method(:enroll!, ENROLL)
    Wasalx::SessionState.define_singleton_method(:rows, ROWS)
  end
  def loaded(store = @store, id = @id)
    request = NativeStateRequest.new({ 'rack.session.options' => NativeStateOptions[:id, id] })
    sid, data = store.send(:find_session, request, id)
    request.env['rack.session'] = NativeStateSession.new(store, request, sid, data)
    request
  end
  def data(id = @id); NativeStateRow.records.fetch(id.private_id)[:data]; end
  def save(request, store = @store)
    session = request.env['rack.session']
    store.send(:write_session, request, session.id, session.to_hash, {})
  end
  def start(request)
    assert_equal 302, NativeStateStrategy.new(request).request_phase[0]
    session = request.env['rack.session']
    { 'state' => session['omniauth.state'], 'nonce' => session['omniauth.nonce'], 'verifier' => session['omniauth.pkce.verifier'] }
  end
  def callback(request, flow, state: flow['state'])
    NativeStateStrategy.new(request, { 'state' => state, 'code' => 'synthetic-code' }, nonce: flow['nonce'], verifier: flow['verifier'])
  end

  def test_exact_dependency_race_reaches_actual_state_error_without_guard
    bare = NativeStateStore.new
    auth, guest = loaded(bare), loaded(bare)
    auth.env['rack.session']['omniauth.state'] = 'pending'
    save(auth, bare)
    guest.env['rack.session']['ping'] = 'later'
    save(guest, bare)
    flow = { 'state' => 'pending', 'nonce' => 'nonce', 'verifier' => 'verifier' }
    probe = NativeStatePinnedStrategy.new(loaded(bare), { 'state' => flow['state'], 'code' => 'synthetic-code' }, nonce: flow['nonce'], verifier: flow['verifier'])
    assert_equal :csrf_detected, probe.callback_call
    assert_equal 0, probe.provider_calls
  end

  def test_stale_guest_write_cannot_remove_staged_auth_state_or_nonce
    auth, guest = loaded, loaded
    flow = start(auth)
    guest.env['rack.session']['ping'] = 'later'
    refute save(guest)
    assert_equal flow['state'], data['omniauth.state']
    probe = callback(loaded, flow)
    assert_equal :accepted, probe.callback_call
    assert_equal 1, probe.provider_calls
    assert_equal 'synthetic-browser', probe.env.dig('omniauth.params', 'fingerprint')
  end

  def test_guest_commit_before_auth_stage_is_benign
    auth, guest = loaded, loaded
    guest.env['rack.session']['ping'] = 'later'
    assert save(guest)
    flow = start(auth)
    assert_equal :accepted, callback(loaded, flow).callback_call
  end

  def test_concurrent_auth_stage_fails_before_returning_unsaved_redirect
    first, second = loaded, loaded
    flow = start(first)
    error = assert_raises(Wasalx::SessionState::Conflict) { NativeStateStrategy.new(second).request_phase }
    assert_equal 'Native sign-in changed; start sign-in again', error.message
    assert_equal flow['state'], data['omniauth.state']
    refute save(second)
  end

  def test_two_loaded_callbacks_cannot_both_exchange_code
    flow = start(loaded)
    probes = [callback(loaded, flow), callback(loaded, flow)]
    results = probes.map { |probe| Thread.new { probe.callback_call } }.map(&:value)
    assert_equal [:accepted, :csrf_detected], results.sort_by(&:to_s)
    assert_equal 1, probes.sum(&:provider_calls)
    refute data.key?('omniauth.state')
  end

  def test_foreign_or_blank_callback_does_not_damage_pending_generation
    flow = start(loaded)
    original = NativeStateRow.copy(data)
    ['foreign', '', nil].each do |state|
      request = loaded
      probe = callback(request, flow, state: state)
      assert_equal :csrf_detected, probe.callback_call
      assert_equal 0, probe.provider_calls
      refute save(request)
      assert_equal original, data
    end
    assert_equal :accepted, callback(loaded, flow).callback_call
  end

  def test_consumed_state_cannot_be_restored_by_stale_whole_write
    flow = start(loaded)
    stale, current = loaded, loaded
    assert_equal :accepted, callback(current, flow).callback_call
    refute save(stale)
    refute data.key?('omniauth.state')
    replay = callback(loaded, flow)
    assert_equal :csrf_detected, replay.callback_call
    assert_equal 0, replay.provider_calls
  end

  def test_deleted_generation_is_not_recreated_from_stale_data_or_pending_refresh
    request = loaded
    request.env['rack.session']['user_id'] = 19
    request.env[Wasalx::SessionRefresh::PENDING] = { 'proof' => 'stale', 'refresh_token' => 'synthetic-only' }
    NativeStateRow.records.delete(@id.private_id)
    refute save(request)
    assert_equal({}, NativeStateRow.records)
    assert_equal 0, @enrollments
  end

  def test_stale_callback_against_new_generation_cannot_enroll_refresh
    flow = start(loaded)
    stale = loaded
    start(loaded)
    stale.env['rack.session']['user_id'] = 19
    stale.env[Wasalx::SessionRefresh::PENDING] = { 'proof' => 'stale', 'refresh_token' => 'synthetic-only' }
    refute save(stale)
    assert_equal 0, @enrollments
    refute_equal flow['state'], data['omniauth.state']
    refute data.key?('user_id')
  end

  def test_owned_rails_reset_has_fresh_generation_and_cannot_resurrect_old_row
    request = loaded
    old = request.env['rack.session'].id
    request.env['rack.session'].destroy
    fresh = request.env['rack.session'].id
    refute_equal old.private_id, fresh.private_id
    request.env['rack.session']['user_id'] = 19
    request.env[Wasalx::SessionRefresh::PENDING] = { 'proof' => 'fresh', 'refresh_token' => 'synthetic-only' }
    assert save(request)
    assert_equal 1, @enrollments
    refute NativeStateRow.records.key?(old.private_id)
    assert_equal 19, data(fresh)['user_id']
  end

  def test_concurrent_logout_denies_reset_instead_of_authorizing_fresh_generation
    request = loaded
    NativeStateRow.records.delete(@id.private_id)
    assert_raises(Wasalx::SessionState::Conflict) { request.env['rack.session'].destroy }
    refute save(request)
    assert_empty NativeStateRow.records
  end

  def test_loaded_renew_captures_only_the_owned_generated_row
    request = loaded
    fresh = @store.send(:delete_session, request, @id, { renew: true })
    request.env['rack.session.options'][:id] = fresh
    request.env['rack.session']['user_id'] = 19
    assert save(request)
    refute NativeStateRow.records.key?(@id.private_id)
    assert_equal 19, data(fresh)['user_id']
  end

  def test_unloaded_renew_and_drop_require_a_still_existing_generation
    [true, false].each do |exists|
      request = NativeStateRequest.new({ 'rack.session.options' => NativeStateOptions[:id, @id] })
      request.env['rack.session'] = NativeStateSession.new(@store, request, @id, {}, loaded: false)
      NativeStateRow.records.delete(@id.private_id) unless exists
      if exists
        fresh = @store.send(:delete_session, request, @id, { renew: true })
        assert request.env.dig(Wasalx::SessionState::SNAPSHOTS, fresh.private_id)
      else
        assert_raises(Wasalx::SessionState::Conflict) { @store.send(:delete_session, request, @id, { drop: true }) }
        assert_raises(Wasalx::SessionState::Conflict) { save(request) }
      end
    end
  end

  def test_native_nonce_and_pkce_rejection_stays_fail_closed
    flow = start(loaded)
    bad_nonce = callback(loaded, flow.merge('nonce' => 'foreign'))
    assert_raises(RuntimeError) { bad_nonce.callback_call }
    assert_equal 1, bad_nonce.provider_calls
    replay = callback(loaded, flow)
    assert_equal :csrf_detected, replay.callback_call
    assert_equal 0, replay.provider_calls
  end

  def test_outer_transaction_never_emits_redirect_or_exchanges_provider_code
    request = loaded
    NativeStateRow.transaction do
      assert_raises(Wasalx::SessionState::Conflict) { NativeStateStrategy.new(request).request_phase }
    end
    request = loaded
    flow = start(request)
    probe = callback(loaded, flow)
    NativeStateRow.transaction { assert_raises(Wasalx::SessionState::Conflict) { probe.callback_call } }
    assert_equal 0, probe.provider_calls
    assert_equal flow['state'], data['omniauth.state']
  end

  def test_new_boundary_errors_are_fixed_and_cannot_become_public_database_messages
    request = loaded
    NativeStateRow.fail_save = true
    error = assert_raises(Wasalx::SessionState::Conflict) { NativeStateStrategy.new(request).request_phase }
    assert_equal 'Native sign-in changed; start sign-in again', error.message
    assert_nil error.cause
    refute save(request)
    NativeStateRow.fail_save = false
    request = loaded
    flow = start(request)
    NativeStateRow.fail_lock = true
    probe = callback(loaded, flow)
    assert_equal :csrf_detected, probe.callback_call
    assert_equal 0, probe.provider_calls
  end

  def test_refresh_is_outer_for_fresh_and_previously_prepended_store
    [NativeStatePreviouslyInstalledStore, NativeStateFreshStore].each do |klass|
      assert_operator klass.ancestors.index(NativeStateRefreshConcern), :<, klass.ancestors.index(Wasalx::SessionState::Store)
    end
  end

  def test_oversized_pending_context_fails_before_redirect
    request = loaded
    request.env['rack.session']['omniauth.params'] = { 'fingerprint' => 'x' * Wasalx::SessionState::LIMIT }
    error = assert_raises(Wasalx::SessionState::Conflict) { Wasalx::SessionState.stage!(request.env, request.env['rack.session']) }
    assert_equal 'Native sign-in changed; start sign-in again', error.message
  end

  def test_lazy_callback_materializes_its_own_framework_snapshot_before_consumption
    flow = start(loaded)
    request = NativeStateRequest.new({ 'rack.session.options' => NativeStateOptions[:id, @id] })
    request.env['rack.session'] = NativeStateSession.new(@store, request, @id, {}, loaded: false)
    refute request.env.key?(Wasalx::SessionState::SNAPSHOTS)
    probe = callback(request, flow)
    assert_equal :accepted, probe.callback_phase
    assert_equal 1, probe.provider_calls
    assert request.env.dig(Wasalx::SessionState::SNAPSHOTS, @id.private_id)
  end

  def test_foreign_valid_flow_cannot_consume_another_session_pending_state
    own_flow = start(loaded)
    foreign = NativeStateSid.new('different-browser')
    NativeStateRow.new(session_id: foreign.private_id, data: {}).save!
    foreign_flow = start(loaded(@store, foreign))
    before = NativeStateRow.copy(NativeStateRow.records)
    probe = callback(loaded, foreign_flow)
    assert_equal :csrf_detected, probe.callback_call
    assert_equal 0, probe.provider_calls
    assert_equal before, NativeStateRow.records
    assert_equal own_flow['state'], data['omniauth.state']
  end

  def test_csrf_and_authenticated_user_transition_cannot_be_overwritten_by_stale_save
    request = loaded
    current = NativeStateRow.find_by_session_id(@id.private_id)
    current.data['_csrf_token'] = 'new-csrf'
    current.data['user_id'] = 12
    current.save!
    refute save(request)
    assert_equal 'new-csrf', data['_csrf_token']
    assert_equal 12, data['user_id']
  end

  def test_native_false_save_never_enrolls_a_pending_grant
    request = loaded
    request.env[Wasalx::SessionRefresh::PENDING] = { 'proof' => 'fresh', 'refresh_token' => 'synthetic-only' }
    NativeStateRow.refuse_save = true
    refute save(request)
    assert_equal 0, @enrollments
  end
end
