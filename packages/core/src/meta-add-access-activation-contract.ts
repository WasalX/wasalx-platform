/** Local receiving admission is separate from every conversation's send authority. */
export const META_ADD_ACCESS_ACTIVATION_REASONS = ['NOT_APPLICABLE','PAUSE_REQUIRED','SETUP_INCOMPLETE',
  'CONNECTION_BUSY','PRIVACY_HOLD','LIFECYCLE_HOLD','ROUTING_REVIEW_REQUIRED',
  'CONTROL_UNRESOLVED','FUNDING_REQUIRED','CREDENTIAL_REQUIRED','READY_TO_CHECK'] as const;
export type MetaAddAccessActivationReason = typeof META_ADD_ACCESS_ACTIVATION_REASONS[number];
export type MetaAddAccessActivationView = {
  connectionId: string; applicable: boolean; readyToCheck: boolean;
  reason: MetaAddAccessActivationReason; contextVersion: string | null;
  operation: { id: string; state: string; locallyActivated: boolean } | null;
  providerConfigurationReadback: false; conversationPermission: 'SEPARATE_REQUIRED';
};
export type MetaAddAccessActivationRequest = { expectedContextVersion: string };
export function parseMetaAddAccessActivationRequest(value: unknown): MetaAddAccessActivationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 1 || !('expectedContextVersion' in value)
    || typeof value.expectedContextVersion !== 'string' || !/^[0-9a-f]{64}$/u.test(value.expectedContextVersion))
    throw new Error('Activation request is invalid');
  return { expectedContextVersion: value.expectedContextVersion };
}
