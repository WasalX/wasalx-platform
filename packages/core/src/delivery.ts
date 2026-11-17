export function backoffMs(attempt:number,random=Math.random){const base=Math.min(15*60_000,1_000*2**Math.max(0,attempt-1));return Math.round(base*(.75+random()*.5))}
