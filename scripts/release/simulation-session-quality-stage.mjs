import { definitions } from './simulation-session-remaining-definitions.mjs';
export { mapSessionQuality } from './simulation-session-contexts.mjs';

// Without selected contextual checks the stage keeps its original owner-desktop obligation.
export function sessionQualityChecks(checks){return checks?.length?checks:definitions.map(definition=>({testId:definition.id,contextId:'tenant_owner-en-desktop'}));}
