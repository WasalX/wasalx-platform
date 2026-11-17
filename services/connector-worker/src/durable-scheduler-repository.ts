import type { Pool } from "pg";
import type { DueTenantWork, DurableSchedulerStore, DurableWorkType } from "./durable-scheduler.js";

type DueRow = { tenant_id: string; work_type: string };
type MetaScan = { nextCursor: string | null; examined: number; ready: Array<{tenantId:string;eventId:string}> };
const uuid=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;

export class DurableSchedulerRepository implements DurableSchedulerStore {
  private metaCursor: string | null = null;
  private scanTail: Promise<void> = Promise.resolve();
  constructor(private readonly pool: Pool) {}

  dueWork(limit = 200): Promise<DueTenantWork[]> {
    // Serialize the existing process-owned cursor, including direct callers.
    const result=this.scanTail.then(()=>this.readDueWork(limit));
    this.scanTail=result.then(()=>undefined,()=>undefined);
    return result;
  }

  private async readDueWork(limit:number):Promise<DueTenantWork[]> {
    await this.pool.query("SELECT app.queue_due_group_syncs($1)", [limit]);
    const result=await this.pool.query<DueRow>("SELECT tenant_id,work_type FROM app.list_due_worker_tenants($1)",[limit]);
    const scanned=await this.pool.query<{page:unknown}>("SELECT app.scan_meta_direct_transition_work($1,$2) AS page",[Math.min(limit,32),this.metaCursor]);
    const page=parseScan(scanned.rows[0]?.page);
    const work:DueTenantWork[]=result.rows.map(row=>({tenantId:row.tenant_id,workType:workType(row.work_type)}));
    for(const ready of page.ready){
      let item=work.find(value=>value.tenantId===ready.tenantId&&value.workType==="delivery");
      if(!item){item={tenantId:ready.tenantId,workType:"delivery"};work.push(item);}
      item.metaTransitionEventIds=[...new Set([...(item.metaTransitionEventIds??[]),ready.eventId])];
    }
    // Advance only after the complete page and ordinary discovery succeeded.
    // A queue failure/deduplicated wake does not remove DB work: wrap reexamines it.
    this.metaCursor=page.nextCursor;
    return work;
  }
}

function parseScan(value:unknown):MetaScan {
  if(!value||typeof value!=="object")throw new Error("Invalid Meta transition scan");
  const input=value as Partial<MetaScan>;
  if(typeof input.examined!=="number"||!Number.isSafeInteger(input.examined)||input.examined<0||input.examined>32
    || !(input.nextCursor===null||typeof input.nextCursor==="string"&&uuid.test(input.nextCursor))
    || !Array.isArray(input.ready)||input.ready.length>input.examined)throw new Error("Invalid Meta transition scan");
  for(const row of input.ready)if(!row||typeof row.tenantId!=="string"||!uuid.test(row.tenantId)
    ||typeof row.eventId!=="string"||!uuid.test(row.eventId))throw new Error("Invalid Meta transition scan");
  if(input.examined===0&&input.nextCursor!==null||input.examined>0&&input.nextCursor===null)throw new Error("Invalid Meta transition scan");
  return input as MetaScan;
}
function workType(value:string):DurableWorkType {
  if(value==="delivery"||value==="inbound"||value==="connection"||value==="privacy"||value==="routing")return value;
  throw new Error("Database returned an unsupported durable work type");
}
