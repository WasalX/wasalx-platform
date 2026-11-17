import assert from 'node:assert/strict';
const disclaimerHandlers=new WeakSet();
export async function admitNativeMailUi(page) {
  const dialog=page.locator('#dialog-beta-ui-disclaimer');
  const dismiss=async target=>{await target.getByRole('button',{name:'Confirm',exact:true}).click({timeout:5000});await target.waitFor({state:'hidden',timeout:5000});};
  // An explicit Confirm action must not invoke a handler that consumes that same button.
  if(disclaimerHandlers.has(page)){await page.removeLocatorHandler(dialog);disclaimerHandlers.delete(page);}
  try{if(await dialog.isVisible())await dismiss(dialog);}
  finally{await page.addLocatorHandler(dialog,dismiss);disclaimerHandlers.add(page);}
}
// Selectors verified against installed 7.1.3 ArticleReply/ArticleBubble/BottomBar.
export async function openMailArticle({page,origin,ticketId,articleId,marker,screenshot,onPhase}) {
  assert.match(String(ticketId),/^\d+$/u);assert.match(String(articleId),/^\d+$/u);
  onPhase?.('direct-native-mail-navigate');await page.goto(`${origin}/desktop/tickets/${ticketId}`);
  await admitNativeMailUi(page);
  const article=page.locator(`[data-test-id="article-bubble-container-${articleId}"]`);
  onPhase?.('direct-native-mail-first-article');await article.waitFor({state:'visible',timeout:20000});
  assert.ok((await article.innerText()).includes(marker));
  onPhase?.('direct-native-mail-reload');await page.reload();onPhase?.('direct-native-mail-reloaded-article');await article.waitFor({state:'visible',timeout:20000});await admitNativeMailUi(page);
  assert.ok((await article.innerText()).includes(marker));
  if(screenshot)await page.screenshot({path:screenshot,fullPage:false});
  return {renderedTicketId:String(ticketId),articleId:String(articleId),reload:true,at:new Date().toISOString()};
}
export async function prepareNativeReplyForm(page) {
  // Native reply actions require the Ticket form, not merely a rendered article.
  await page.getByRole('button',{name:'Ticket',exact:true}).click();
  await page.getByRole('combobox',{name:'State',exact:true}).waitFor({state:'visible',timeout:20000});
}
export async function waitForNativeReplyEditor(page) {
  const form=page.locator('#ticketArticleReplyForm');await form.waitFor({state:'visible'});
  const editor=form.locator('[contenteditable="true"]');await editor.waitFor({state:'visible'});
  assert.equal(await editor.count(),1,'Require one real article editor');return editor;
}
export async function submitMailReply({page,marker,intentId,checkpoint}) {
  assert.match(marker,/^[\w -]{1,150}$/u);assert(intentId);
  await admitNativeMailUi(page);
  await prepareNativeReplyForm(page);
  await page.getByRole('button',{name:'Reply to customer',exact:true}).click();
  const editor=await waitForNativeReplyEditor(page);
  await editor.fill(marker);
  // Record before Update: if it times out, read native article by marker; no reclick.
  await checkpoint({phase:'intent',step:'native-public-email-reply',intentId,marker,at:new Date().toISOString()});
  const update=page.getByRole('button',{name:'Update',exact:true});assert.equal(await update.count(),1);await update.click();
  await checkpoint({phase:'submitted',step:'native-public-email-reply',intentId,at:new Date().toISOString()});
  // Submission is deliberately not called delivery success. Native DB+SMTP required.
}
export async function downloadMailAttachment({page,origin,ticketId,articleId,attachmentId}) {
  for(const id of [ticketId,articleId,attachmentId])assert.match(String(id),/^\d+$/u);
  const result=await page.evaluate(async path=>{const response=await fetch(path);return{status:response.status,bytes:Array.from(new Uint8Array(await response.arrayBuffer()))};},`/api/v1/ticket_attachment/${ticketId}/${articleId}/${attachmentId}`);
  assert.equal(new URL(page.url()).origin,origin);assert.equal(result.status,200);
  return{authenticated:true,status:result.status,bytes:Buffer.from(result.bytes)};
}

export async function waitForNativeImagePreview(article,filename){
 const image=article.getByRole('img',{name:'Image of '+filename,exact:true});
 await image.waitFor({state:'visible'});
 const decoded=await image.evaluate(async node=>{await node.decode();return node.complete&&node.naturalWidth>0});
 if(!decoded)throw Error('Native image preview did not decode');
}
