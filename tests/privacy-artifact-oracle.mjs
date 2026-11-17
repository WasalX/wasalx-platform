import assert from 'node:assert/strict';

// Common exact contents check for real worker storage bytes or an actual downloaded artifact.
export function assertMetaCostPrivacyArtifactContents({bytes,summary,expectedAssessments,expectedTariffs,scopeType}) {
  const document=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  const wire=rows=>JSON.parse(JSON.stringify(rows));
  const byId=rows=>[...rows].sort((left,right)=>left.id.localeCompare(right.id));
  assert(Array.isArray(document.local.metaCostAssessments));
  assert(Array.isArray(document.local.metaCostTariffs));
  assert.deepEqual(byId(document.local.metaCostAssessments),byId(wire(expectedAssessments)),
    'The artifact must contain every actually selected historical revision, excluding redacted and out-of-scope evidence');
  assert.deepEqual(byId(document.local.metaCostTariffs),byId(wire(scopeType==='TENANT'?expectedTariffs:[])),
    'Participant/ticket/reference exports must not acquire shared tariff configuration');
  assert(document.local.metaCostAssessments.every(row=>row.evidence_redacted_at===null));
  assert.equal(summary.metaCostAssessments,expectedAssessments.length);
  assert.equal(summary.metaCostTariffs,scopeType==='TENANT'?expectedTariffs.length:0);
  // Summary is a count-only projection; artifact evidence must not leak into
  // ordinary worker outcome records through an accidental generic spread.
  assert.equal(typeof summary.metaCostAssessments,'number');
  assert.equal(typeof summary.metaCostTariffs,'number');
  for(const row of [...expectedAssessments,...expectedTariffs]) {
    assert(!JSON.stringify(summary).includes(row.id));
  }
  return document;
}
// Canonical database fixture additionally proves its real excluded records.
export function assertMetaCostPrivacyArtifact({bytes,summary,expectedAssessments,expectedTariffs,scopeType,excludedAssessmentIds}) {
  const document=assertMetaCostPrivacyArtifactContents({bytes,summary,expectedAssessments,expectedTariffs,scopeType});
  assert(Array.isArray(excludedAssessmentIds)&&excludedAssessmentIds.length>=3,"Bind redacted, unrelated and foreign assessment IDs from the real fixture");
  for(const id of excludedAssessmentIds)assert(!document.local.metaCostAssessments.some(row=>row.id===id));
}
