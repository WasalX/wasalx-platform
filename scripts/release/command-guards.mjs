import assert from 'node:assert/strict';
export function assertOneOffStopped(container){if(container===null)return;assert(container?.State,'Unknown one-off state prevents normal consumer restoration');assert.equal(container.State.Running,false,'One-off still running: keep normal worker stopped');assert.equal(container.State.Restarting,false);assert(['exited','dead'].includes(container.State.Status),'Unconfirmed one-off termination');}
// Exact eligibility from migrations/0004_inbound_runtime.sql app.claim_inbound_events.
export const CLAIMABLE_SQL="SELECT id FROM event_inbox WHERE ((status IN ('ACCEPTED','FAILED_RETRYABLE') AND available_at<=now()) OR (status='PROCESSING' AND lease_expires_at<now())) AND (lease_expires_at IS NULL OR lease_expires_at<now()) ORDER BY id";

export function assertCommandCompleted(row){assert.equal(row.status,'PROCESSED');assert(row.processed_at,'Missing durable completion');assert.equal(row.lease_id,null);assert.equal(row.lease_expires_at,null);}