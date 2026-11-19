export async function withAuthenticatedSimulationOwnerPage({browser,portalOrigin,keycloakOrigin,tenantId,authenticateOwnerPending,verifyOwner},work){
 const context=await browser.newContext({viewport:{width:1440,height:1000}});let primary,result,failed=false;
 try{const page=await context.newPage();await page.goto(portalOrigin+'/auth/login?return_to=/app&tenant_id='+encodeURIComponent(tenantId),{waitUntil:'domcontentloaded'});if(new URL(page.url()).origin===keycloakOrigin)await authenticateOwnerPending(page);await verifyOwner(page);result=await work(page);}catch(error){primary=error;failed=true;}
 try{await context.close();}catch(error){if(!failed){primary=error;failed=true;}}
 if(failed)throw primary;
 return result;
}
