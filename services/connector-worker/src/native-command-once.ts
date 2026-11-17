// PRIVATE processor boundary proposal; no scheduler and no automatic native replay.
export async function nativeCommandOnce<T extends {state:string}>(action:{state:string;result?:T}, io:{readReceipt:()=>Promise<T>;validReceipt:(result:T)=>boolean;recordSuccess:(result:T)=>Promise<void>;claimAttempt:()=>Promise<boolean>;closeOnce:()=>Promise<T>;recordUnknown:()=>Promise<void>}) {
  if (action.state === 'SUCCEEDED') return {state:'SUCCEEDED',result:action.result,replay:true};
  if (action.state === 'FAILED_TERMINAL') return {state:'FAILED_TERMINAL',replay:true};
  if (action.state === 'ATTEMPTED' || action.state === 'OUTCOME_UNKNOWN') {
    const result = await io.readReceipt();
    if (result.state !== 'SUCCEEDED') return {state:'OUTCOME_UNKNOWN',replay:true};
    if (!io.validReceipt(result)) throw new Error('Native command receipt conflict');
    await io.recordSuccess(result);
    return {state:'SUCCEEDED',result,replay:true};
  }
  if (action.state !== 'PREPARED') throw new Error('Invalid native action state');
  if (!await io.claimAttempt()) return {state:'HELD',replay:false};
  try {
    const result = await io.closeOnce();
    if (!io.validReceipt(result)) throw new Error('Native command receipt conflict');
    await io.recordSuccess(result);
    return {state:'SUCCEEDED',result,replay:false};
  } catch {
    await io.recordUnknown();
    return {state:'OUTCOME_UNKNOWN',replay:false};
  }
}
