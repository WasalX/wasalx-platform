export function parseRailsJson(value){
 for(const line of value.toString().split(/\r?\n/u).reverse()){
  const candidate=line.trim();if(!candidate.startsWith('{'))continue;
  try{const parsed=JSON.parse(candidate);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))return parsed;}catch{/* Continue to the next candidate line. */}
 }
 throw Error('Rails JSON readback absent');
}
