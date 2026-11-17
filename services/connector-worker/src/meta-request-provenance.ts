import {createHash} from "node:crypto";
import {open,lstat} from "node:fs/promises";
import {constants} from "node:fs";
import type {ActualRequestExecution} from "../../../packages/core/src/meta-account-policy.js";

const receiptPath="/run/wasalx/meta-request-provenance.json";
const unknown:ActualRequestExecution={mode:"UNKNOWN",runtimeEvidenceReceiptId:null,runtimeEvidenceSha256:null,transportBindingSha256:null};
export type MetaActualTransport={graphVersion:string;transportBindingSha256:string};
type RuntimeDescriptor={schemaVersion:1;receiptId:string;workerImageDigest:string;sourceTree:string;
 graphVersion:string;releaseEvidenceSha256:string;transportBindingSha256:string};
export type MetaRuntimeEvidenceCandidate={receiptId:string;descriptor:RuntimeDescriptor;descriptorSha256:string};

/** Fixed read-only deployment mount. A public flag/env mode can never supply it.
 * The deployment producer must bind the exact verified image/transport approval;
 * this reader is not a substitute for that producer or remote attestation. */
export async function currentMetaRuntimeCandidate(actual:MetaActualTransport):Promise<MetaRuntimeEvidenceCandidate|undefined>{
 if(process.platform==="win32")return undefined;
 try{
  const info=await lstat(receiptPath);
  if(!info.isFile()||info.isSymbolicLink()||info.uid!==0||(info.mode&0o222)!==0||info.size>8192)return undefined;
  const file=await open(receiptPath,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
   const opened=await file.stat();
   if(opened.dev!==info.dev||opened.ino!==info.ino||opened.size!==info.size)return undefined;
   const bytes=await file.readFile();if(bytes.length>8192)return undefined;
   const descriptor=parseMetaRuntimeDescriptor(JSON.parse(Buffer.from(bytes).toString("utf8")));
   if(descriptor.graphVersion!==actual.graphVersion||descriptor.transportBindingSha256!==actual.transportBindingSha256)return undefined;
   return{receiptId:descriptor.receiptId,descriptor,descriptorSha256:createHash("sha256").update(bytes).digest("hex")};
  }finally{await file.close();}
 }catch{return undefined;}
}
export function parseMetaRuntimeDescriptor(value:unknown):RuntimeDescriptor{
 const v=value as Record<string,unknown>;
 const keys=["schemaVersion","receiptId","workerImageDigest","sourceTree","graphVersion","releaseEvidenceSha256","transportBindingSha256"];
 if(!v||typeof v!=="object"||Array.isArray(v)||Object.keys(v).length!==keys.length||keys.some(key=>!Object.hasOwn(v,key))||v.schemaVersion!==1
  ||typeof v.receiptId!=="string"||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(v.receiptId)
  ||typeof v.workerImageDigest!=="string"||!/^sha256:[a-f0-9]{64}$/u.test(v.workerImageDigest)
  ||typeof v.sourceTree!=="string"||!/^[a-f0-9]{40,64}$/u.test(v.sourceTree)
  ||typeof v.graphVersion!=="string"||!/^v[0-9]+\.[0-9]+$/u.test(v.graphVersion)
  ||![v.releaseEvidenceSha256,v.transportBindingSha256].every(value=>typeof value==="string"&&/^[a-f0-9]{64}$/u.test(value)))
  throw new Error("Approved Meta runtime evidence is unavailable");
 return v as RuntimeDescriptor;
}
export function unknownMetaRequestExecution():ActualRequestExecution{return{...unknown};}
