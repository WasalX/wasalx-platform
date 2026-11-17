-- Signed pricing observations are diagnostic evidence, not charges or payer proof.
-- Legacy receipts stay NULL: no invented historical hashes or prices.
ALTER TABLE delivery_receipts
  ADD COLUMN meta_pricing_version smallint,
  ADD COLUMN meta_pricing_state text,
  ADD COLUMN meta_pricing_reason text,
  ADD COLUMN meta_pricing_model text,
  ADD COLUMN meta_pricing_category text,
  ADD COLUMN meta_pricing_type text,
  ADD COLUMN meta_pricing_billable boolean,
  ADD COLUMN meta_pricing_revision_sha256 text,
  ADD COLUMN meta_observed_envelope_account_id text,
  ADD COLUMN meta_observed_phone_number_id text,
  ADD CONSTRAINT delivery_receipts_meta_pricing_shape CHECK ((
    num_nonnulls(meta_pricing_version,meta_pricing_state,meta_pricing_reason,
      meta_pricing_model,meta_pricing_category,meta_pricing_type,meta_pricing_billable,
      meta_pricing_revision_sha256,meta_observed_envelope_account_id,meta_observed_phone_number_id)=0
    OR (
      provider='META' AND meta_pricing_version=1
      AND meta_pricing_revision_sha256~'^[0-9a-f]{64}$'
      AND (meta_observed_envelope_account_id IS NULL OR meta_observed_envelope_account_id~'^[0-9]{1,32}$')
      AND (meta_observed_phone_number_id IS NULL OR meta_observed_phone_number_id~'^[0-9]{1,32}$')
      AND (
        (meta_pricing_state='VALID' AND meta_pricing_reason IS NULL
          AND meta_pricing_model IN ('PMP','CBP')
          AND meta_pricing_category IN ('marketing','utility','authentication','service','referral_conversion','general_purpose_ai')
          AND meta_pricing_type IN ('regular','free_customer_service','free_entry_point')
          AND meta_pricing_billable IS NOT NULL)
        OR
        (meta_pricing_state IN ('ABSENT','UNAVAILABLE')
          AND num_nonnulls(meta_pricing_model,meta_pricing_category,meta_pricing_type,meta_pricing_billable)=0
          AND ((meta_pricing_state='ABSENT' AND meta_pricing_reason IS NULL)
            OR (meta_pricing_state='UNAVAILABLE' AND meta_pricing_reason IN ('SHAPE','SIZE','FIELDS','VALUE'))))
      )
    )
  ) IS TRUE);

-- Keep 0137's existing append-only + authorized identity-redaction trigger.
-- Its whole-row comparison includes these columns without replacement. Tenant
-- RLS/FKs, receipt uniqueness and the privacy write fence remain in force.
