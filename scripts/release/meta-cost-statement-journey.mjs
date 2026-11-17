// NEVER_RUN_HOSTED_CI: manual live-provider driver; supply account inputs and credentials at runtime.
import {pathToFileURL as manualDriverFileUrl} from "node:url";
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && process.argv[1] && import.meta.url === manualDriverFileUrl(process.argv[1]).href) throw new Error("Live provider drivers must never run in hosted CI");
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function downloaded(download){
 const stream=await download.createReadStream();assert(stream);const chunks=[];let size=0;
 for await(const chunk of stream){size+=chunk.length;assert(size<=10_485_760);chunks.push(chunk);}return Buffer.concat(chunks);
}

/** Called by the existing exact-stack driver with its owned authenticated page
 * and real P08/P10 fixture. No login, authority row, mode override, direct API
 * mutation or provider call is created here. The caller opens the actual Usage
 * drawer and selects the exact account/period before invoking this journey.
 * A normalized description and independent synthetic review receipt are fixture
 * inputs, not evidence of a live document or commercial approval. */
export async function runMetaCostStatementJourney({page,tenantId,description,original,reviewSha256,labels,expectedOrigin,expectedMode='SIMULATED',responseLossScope}){
 assert.equal(expectedMode,'SIMULATED','This development journey cannot qualify live financial authority');
 assert.equal(new URL(page.url()).origin,expectedOrigin);assert.match(tenantId,/^[a-f0-9-]{36}$/u);assert.match(reviewSha256,/^[a-f0-9]{64}$/u);
 const section=page.getByRole('region',{name:labels.manage,exact:true}),root=`/api/platform-console/meta-costs/tenants/${tenantId}/statements`;
 const response=(path,method='POST')=>page.waitForResponse(value=>new URL(value.url()).origin===expectedOrigin&&new URL(value.url()).pathname===path&&value.request().method()===method,{timeout:135_000});
 const action=async(path,perform)=>{const wait=response(path);await perform();const result=await wait;assert.equal(result.ok(),true,`${path}: ${result.status()}`);return result.json();};
 const jsonFile=value=>({name:'synthetic-reviewed-description.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(value))});
 await section.getByLabel(labels.descriptionFile,{exact:true}).setInputFiles(jsonFile(description));
 const reservation=await action(root,()=>section.getByRole('button',{name:labels.reserve,exact:true}).click());assert.match(reservation.id,/^[a-f0-9-]{36}$/u);
 const detailPath=`${root}/${reservation.id}`;
 const firstDetail=response(detailPath,'GET');await section.getByLabel(labels.version,{exact:true}).selectOption(reservation.id);let current=await(await firstDetail).json();
 assert.equal(current.evidenceMode,expectedMode);assert.equal(current.description.accountId,description.accountId);
 const reload=async()=>{const wait=response(detailPath,'GET');await section.getByRole('button',{name:labels.reload,exact:true}).click();return(await wait).json();};
 if(description.basisKind==='UPSTREAM_SOURCE'){
  assert(original);assert.equal(sha(original.bytes),description.source.originalSha256);assert.equal(original.bytes.length,description.source.originalByteSize);
  const upload=response(detailPath+'/source','PUT');await section.getByLabel(labels.original,{exact:true}).setInputFiles({name:original.name,mimeType:description.source.originalMime,buffer:Buffer.from(original.bytes)});
  const uploaded=await upload;assert.equal(uploaded.ok(),true);assert.equal((await uploaded.json()).state,'READY');current=await reload();
  const transfer=page.waitForEvent('download');await section.getByRole('button',{name:labels.downloadOriginal,exact:true}).click();
  assert.equal(sha(await downloaded(await transfer)),description.source.originalSha256);
 }
 const worksheetDownload=page.waitForEvent('download');await section.getByRole('button',{name:labels.reviewWorksheet,exact:true}).click();
 const worksheet=JSON.parse((await downloaded(await worksheetDownload)).toString('utf8'));
 assert.equal(worksheet.expectedVersion,current.version);assert.equal(worksheet.expectedInputSha256,current.inputSha256);
 assert.equal(worksheet.expectedCurrentHeadId,current.currentHeadId);
 // This base/replacement journey requires the caller to provide explicit prior
 // adjustment decisions; it never guesses inclusion from a later source total.
 if(worksheet.priorAdjustments.length){
  assert(Array.isArray(original?.priorAdjustments));assert.equal(original.priorAdjustments.length,worksheet.priorAdjustments.length);
  worksheet.priorAdjustments=original.priorAdjustments;
 }
 worksheet.reviewSha256=reviewSha256;
 await section.getByLabel(labels.reviewFile,{exact:true}).setInputFiles(jsonFile(worksheet));
 await section.getByLabel(labels.confirmReview,{exact:true}).check();
 await action(detailPath+'/review',()=>section.getByRole('button',{name:labels.recordReview,exact:true}).click());current=await reload();assert.equal(current.state,'REVIEWED');
 await action(detailPath+'/preview',()=>section.getByRole('button',{name:labels.preview,exact:true}).click());current=await reload();assert(current.previewSha256);assert.equal(current.preview.evidenceMode,expectedMode);
 const published=responseLossScope?await publishAfterLostResponse({page,detailPath,labels,expectedOrigin,
  originalScope:{accountId:description.accountId,from:description.periodFrom,to:description.periodTo},responseLossScope}):
  await action(detailPath+'/publish',()=>section.getByRole('button',{name:labels.publish,exact:true}).click());assert.equal(published.state,'PUBLISHED');
 current=await reload();assert.equal(current.state,'PUBLISHED');assert.equal(current.publicationSha256,published.publicationSha256);
 assert.equal(current.publication.claim,'DOCUMENTARY_RECONCILIATION_NOT_PAYMENT');assert.equal(current.publication.evidenceMode,expectedMode);
 const preserved={id:current.id,publicationSha256:current.publicationSha256,amount:current.publication.amount,currency:current.publication.currency};
 // The actual drawer reload above reads persisted state. A full-page reload
 // closes the transient drawer and belongs to the owning navigation driver.
 return{...preserved,mode:expectedMode,originalSha256:description.basisKind==='UPSTREAM_SOURCE'?description.source.originalSha256:null,
  claim:'ACTUAL_UI_TO_API_DATABASE_AND_STORAGE_SIMULATED_JOURNEY',responseLoss:responseLossScope?'CONTROLLED_BROWSER_RESPONSE_LOSS':'NONE',externalAuthority:'NOT_QUALIFIED'};
}

async function publishAfterLostResponse({page,detailPath,labels,expectedOrigin,originalScope,responseLossScope}){
 assert.notEqual(responseLossScope.accountId,originalScope.accountId);assert.notEqual(responseLossScope.from,originalScope.from);
 const exact=expectedOrigin+detailPath+'/publish';let calls=0,firstIntent,committed;
 const handler=async route=>{
  const request=route.request();if(request.method()!=='POST')return route.continue();calls++;
  const intent={path:new URL(request.url()).pathname,body:request.postData(),key:request.headers()['idempotency-key']};assert(intent.key);
  if(calls===1){firstIntent=intent;const actual=await route.fetch();assert(actual.ok());committed=await actual.json();assert.equal(committed.state,'PUBLISHED');await route.abort('failed');}
  else{assert.equal(calls,2);assert.deepEqual(intent,firstIntent);await route.continue();}
 };
 await page.route(exact,handler);
 try{
  await page.getByRole('region',{name:labels.manage,exact:true}).getByRole('button',{name:labels.publish,exact:true}).click();
  const reconcile=page.getByRole('button',{name:labels.reconcile,exact:true});await reconcile.waitFor();assert(committed);
  const select=async scope=>{
   await page.getByLabel(labels.account,{exact:true}).selectOption(scope.accountId);
   await page.getByLabel(labels.from,{exact:true}).fill(scope.from.slice(0,16));await page.getByLabel(labels.to,{exact:true}).fill(scope.to.slice(0,16));
  };
  await select(responseLossScope);
  const reply=page.waitForResponse(value=>value.url()===exact&&value.request().method()==='POST');await reconcile.click();
  const actual=await reply;assert(actual.ok());const recovered=await actual.json();assert.equal(recovered.duplicate,true);
  assert.equal(recovered.id,committed.id);assert.equal(recovered.publicationSha256,committed.publicationSha256);assert.equal(calls,2);
  await select(originalScope);
  const detail=page.waitForResponse(value=>value.url()===expectedOrigin+detailPath&&value.request().method()==='GET');
  await page.getByRole('region',{name:labels.manage,exact:true}).getByLabel(labels.version,{exact:true}).selectOption(committed.id);
  const restored=await(await detail).json();assert.equal(restored.publicationSha256,committed.publicationSha256);return recovered;
 }finally{await page.unroute(exact,handler);}
}

/** Actual tenant page already open to the same account/period. The exported
 * file is observed through the browser; no interception or mock endpoint. */
export async function exportMetaCostStatementHistory({page,labels,expectedOrigin,statementId,expectedPublicationSha256}){
 assert.equal(new URL(page.url()).origin,expectedOrigin);const section=page.getByRole('region',{name:labels.title,exact:true});
 const download=page.waitForEvent('download');await section.getByRole('button',{name:labels.export,exact:true}).click();const bytes=await downloaded(await download),text=bytes.toString('utf8');
 assert(text.includes(statementId));assert(text.includes(expectedPublicationSha256));return{sha256:sha(bytes),byteSize:bytes.length,containsPublishedRevision:true};
}


/** Continue on an actual tenant page and inspect immutable published detail and
 * exported bytes. `expected` comes from the caller's independent actual-domain
 * publication oracle, never reconstructed from this UI or rounded in JS. */
export async function verifyMetaCostStatementBreakdown({page,labels,expectedOrigin,expected}){
 assert.equal(new URL(page.url()).origin,expectedOrigin);
 assert.equal(expected.evidenceMode,'SIMULATED','Development fixture is not live financial authority');
 assert.equal(typeof expected.amount,'string');assert.equal(typeof expected.estimatedAmount,'string');assert.equal(typeof expected.difference,'string');
 assert(Array.isArray(expected.adjustments)&&expected.adjustments.length>0);
 const panel=page.getByRole('region',{name:labels.title,exact:true});
 // Caller supplies the exact current published row through period/basis/state,
 // never a raw provider identifier inserted into the public user interface.
 const row=panel.getByRole('row').filter({has:panel.getByText(`${expected.currency} ${expected.amount}`,{exact:true})});
 assert.equal(await row.count(),1,'Published statement row must be unambiguous');
 await row.getByRole('button',{name:labels.details,exact:true}).focus();await page.keyboard.press('Enter');
 const detail=panel.getByRole('region',{name:labels.details,exact:true});
 await detail.getByText(`${expected.currency} ${expected.estimatedAmount}`,{exact:true}).waitFor();
 await detail.getByText(`${expected.currency} ${expected.difference}`,{exact:true}).waitFor();
 for(const item of expected.adjustments){
  assert.equal(typeof item.amount,'string');assert(['INCLUDED_IN_REPLACEMENT','EXCLUDED_FROM_REPLACEMENT'].includes(item.treatment));
  const adjustment=detail.getByRole('row').filter({hasText:`${expected.currency} ${item.amount}`});
  assert.equal(await adjustment.count(),1);await adjustment.getByText(labels.treatment[item.treatment],{exact:true}).waitFor();
 }
 const pending=page.waitForEvent('download');await panel.getByRole('button',{name:labels.export,exact:true}).click();
 const bytes=await downloaded(await pending),csv=verifyMetaCostStatementCsv(bytes,expected);
 await detail.getByRole('button',{name:labels.closeDetails,exact:true}).focus();await page.keyboard.press('Enter');
 return{sha256:sha(bytes),byteSize:bytes.length,statementRows:1,adjustmentRows:csv.adjustmentRows,
  claim:'ACTUAL_TENANT_UI_PUBLISHED_DETAIL_AND_DOWNLOADED_BYTES',mode:'SIMULATED',externalAuthority:'NOT_QUALIFIED'};
}

/** Finite quoted CSV projection emitted by metaCostStatementCsv. Retain raw
 * bytes/hash; decode only CSV quoting and the documented negative-cell prefix. */
export function verifyMetaCostStatementCsv(bytes,expected){
 assert(bytes.length<=10_485_760);const text=Buffer.from(bytes).toString('utf8');
 const lines=text.replace(/^\uFEFF/u,'').split('\r\n');assert.equal(lines.pop(),'');assert(lines.length<=10001);
 const decode=line=>{const cells=[...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/gu)];assert.equal(cells.map(x=>x[0]).join(''),line,'Exact quoted CSV');return cells.map(x=>x[1].replaceAll('""','"'));};
 const headers=decode(lines.shift());assert.equal(new Set(headers).size,headers.length);
 const index=name=>{const i=headers.indexOf(name);assert(i>=0);return i;};
 const rows=lines.map(line=>{const values=decode(line);assert.equal(values.length,headers.length);return values;});
 const money=(actual,exact)=>{assert.equal(typeof exact,'string');assert.match(exact,/^-?\d+(?:\.\d+)?$/u);
  assert.equal(actual,exact.startsWith('-')?"'"+exact:exact,'Exact decimal and required formula protection');};
 const statements=rows.filter(row=>row[index('rowType')]==='STATEMENT'&&row[index('id')]===expected.id);assert.equal(statements.length,1);
 for(const key of ['amount','estimatedAmount','difference'])money(statements[0][index(key)],expected[key]);
 const adjustments=rows.filter(row=>row[index('rowType')]==='ADJUSTMENT'&&row[index('id')]===expected.id);assert.equal(adjustments.length,expected.adjustments.length);
 for(const item of expected.adjustments){
  const matches=adjustments.filter(row=>row[index('adjustmentStatementId')]===item.statementVersionId&&row[index('adjustmentTreatment')]===item.treatment);assert.equal(matches.length,1);
  money(matches[0][index('adjustmentAmount')],item.amount);assert.equal(matches[0][index('amount')],'','Adjustment does not duplicate the statement total');
 }
 for(const forbidden of ['selectedRows','providerMessageId','admissionSha256','subjectRefs'])assert(!text.includes(forbidden));
 return{sha256:sha(bytes),byteSize:bytes.length,statementRows:1,adjustmentRows:adjustments.length};
}
