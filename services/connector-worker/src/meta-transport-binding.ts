import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {assertMetaDirectTransportStartup} from "../../../packages/core/src/meta-account-policy.js";
const sha=(bytes:Uint8Array|string)=>createHash("sha256").update(bytes).digest("hex");
/** Digests actual process transport inputs; no access token, mode flag, hostname,
 * credential, proxy URL or CA body is returned. Missing input means UNKNOWN. */
export async function currentMetaTransportBinding(graphVersion:string){
 if(!/^v[0-9]+\.[0-9]+$/u.test(graphVersion))throw new Error("Meta transport is unavailable");
 const env=process.env;
 // Additional loaders/dispatchers cannot silently inherit an approved transport.
 assertMetaDirectTransportStartup(env,process.execArgv);
 const bounded=async(path:string)=>{const bytes=await readFile(path);if(bytes.length>1024*1024)throw new Error("Meta transport is unavailable");return sha(bytes);};
 const projection={schemaVersion:1,graphVersion,directStartupVerified:true,endpoint:"https://graph.facebook.com",
  hostsSha256:await bounded("/etc/hosts"),resolverSha256:await bounded("/etc/resolv.conf"),
  extraCaSha256:env.NODE_EXTRA_CA_CERTS?await bounded(env.NODE_EXTRA_CA_CERTS):null,
  proxySha256:sha(JSON.stringify([env.HTTP_PROXY||null,env.HTTPS_PROXY||null,env.ALL_PROXY||null,env.NO_PROXY||null,
   env.http_proxy||null,env.https_proxy||null,env.all_proxy||null,env.no_proxy||null,env.NODE_USE_ENV_PROXY||null]))};
 return{projection,transportBindingSha256:sha(JSON.stringify(projection))};
}
