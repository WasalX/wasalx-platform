// Main-only, run in isolated keycloak-bootstrap network context with private env.
import assert from 'node:assert/strict';
const origin=(port)=>{assert(/^\d+$/.test(port));return `http://127.0.0.1:${port}`;};
const portal=origin(process.env.PORTAL_PORT),native=origin(process.env.ZAMMAD_PORT);
const base='http://127.0.0.1:8080';
const auth=await fetch(base+'/realms/master/protocol/openid-connect/token',{method:'POST',body:new URLSearchParams({grant_type:'password',client_id:'admin-cli',username:process.env.KEYCLOAK_ADMIN,password:process.env.KEYCLOAK_ADMIN_PASSWORD}),signal:AbortSignal.timeout(10000)});
assert(auth.ok);const {access_token:token}=await auth.json();assert(token);
for(const [realm,clientId,root,paths,logout] of [['wasalx','wasalx-portal',portal,['/auth/callback','/invitations/callback'],'/*'],['wasalx-platform','wasalx-platform-portal',portal,['/platform/auth/callback'],'/platform/*'],['wasalx','wasalx-00000000000040008000000000000001',native,['/auth/openid_connect/callback'],'/*']]){
 const h={authorization:`Bearer ${token}`};const response=await fetch(`${base}/admin/realms/${realm}/clients?clientId=${clientId}`,{headers:h,signal:AbortSignal.timeout(10000)});assert(response.ok);
 const rows=await response.json();assert.equal(rows.length,1,`exact existing client ${clientId}`);const c=rows[0];
 c.redirectUris=paths.map(p=>root+p);c.webOrigins=[root];c.attributes={...c.attributes,'post.logout.redirect.uris':root+logout};
 if(realm==='wasalx'&&clientId==='wasalx-portal'){
  c.frontchannelLogout=false;c.attributes['backchannel.logout.url']='http://portal:3000/auth/backchannel-logout';c.attributes['backchannel.logout.session.required']='true';
 }
 if(paths.includes('/auth/openid_connect/callback')){
  c.enabled=false;c.standardFlowEnabled=false;c.redirectUris=[];c.webOrigins=[];c.frontchannelLogout=false;c.attributes['post.logout.redirect.uris']='';c.attributes['backchannel.logout.url']='http://zammad-nginx:8080/auth/openid_connect/backchannel_logout';c.attributes['backchannel.logout.session.required']='true';
 }
 const result=await fetch(`${base}/admin/realms/${realm}/clients/${c.id}`,{method:'PUT',headers:{...h,'content-type':'application/json'},body:JSON.stringify(c),signal:AbortSignal.timeout(10000)});assert.equal(result.status,204);
 console.log(JSON.stringify({realm,clientId,status:'origins-updated',redirectUris:c.redirectUris}));
}
