import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createOwnedIntentRegistry} from './owned-intent-registry.mjs';
// One serial stage: the same gate fences network submission and settlement observation.
export function createDirectDispatchFence({checkpoint,control,observe}){
 const registry=createOwnedIntentRegistry(checkpoint),digests=new Map();let busy=false,drainFailure,reconciled=false;
 return{
  async control(command){
   assert(!busy,'Direct dispatch or settlement is active');assert(!drainFailure,'Failed settlement requires reconciliation');assert.equal(command.action,'inbound');
   const eventId=command.input?.eventId;assert(typeof eventId==='string'&&eventId.length);
   const digest=createHash('sha256').update(JSON.stringify(command)).digest('hex');
   busy=true;
   try{
    if(digests.has(eventId))assert.equal(digests.get(eventId),digest,'Changed replay payload');
    else{await registry.register({kind:'inbound',eventId});digests.set(eventId,digest);}
    return await control(command);
   }finally{busy=false;}
  },
  async drain(){
   assert(!busy,'Direct dispatch or settlement is active');busy=true;
   try{
    const entries=registry.entries();
    await checkpoint({phase:'direct-dispatch-fenced',entries});
    const view={closed:true,entries:()=>entries.map(x=>({...x}))};
    if(drainFailure){if(!reconciled){reconciled=true;try{await observe(view,{readbackOnly:true});}catch(error){throw new AggregateError([drainFailure,error],'Prior settlement failed; configuration remains held');}}throw drainFailure;}
    try{return await observe(view,{readbackOnly:false});}catch(error){drainFailure=error;throw error;}
   }finally{busy=false;}
  },
 };
}
