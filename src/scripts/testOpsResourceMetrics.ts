// Pure injected scheduler dependencies. No Prisma/app/provider/queue is loaded.
import assert from 'node:assert/strict';
import {OpsScheduler, OPS_INTERVALS, type OpsState} from '../services/opsScheduler.js';
let checks=0;
const check=(ok:unknown)=>{assert.ok(ok);checks++;};
async function scenario(cpu?:()=>{user:number;system:number},fail=false){
  let now=1_800_000_000_000,state:OpsState={},writes=0,runs=0,publishes=0;
  const scheduler=new OpsScheduler({now:()=>now,enabled:()=>true,cpuUsage:cpu,
    read:async()=>state,mutate:async(_lane,change)=>{writes++;const next=change(state);state=next.state;return next.result;},
    publish:async()=>{publishes++;},run:async()=>{runs++;now+=1250;if(fail)throw Error('Synthetic compute time quota exceeded');return{synthetic:true};}});
  const tick={version:1 as const,lane:'financial' as const,slot:now};
  if(fail){await assert.rejects(scheduler.tick(tick),/quota/);checks++;}
  else{await scheduler.tick(tick);check(state.lastDurationMs===1250);check(state.completedSlot===tick.slot);const prior={writes,runs,publishes};await scheduler.tick(tick);assert.deepEqual({writes,runs,publishes},{writes:prior.writes+1,runs:prior.runs,publishes:prior.publishes});checks++;}
  check(runs===1&&publishes===1);
  return{state,writes};
}
let calls=0;const good=await scenario(()=>++calls===1?{user:1000,system:2000}:{user:123456,system:44000});
check(good.state.lastCpuMs===164.456);check(calls===2);check(good.writes===4);
const unavailable=await scenario(()=>{throw Error('Synthetic unavailable measurement');});check(unavailable.state.lastCpuMs===undefined);
const invalid=await scenario(()=>({user:Number.NaN,system:1}));check(invalid.state.lastCpuMs===undefined);
calls=0;const reset=await scenario(()=>++calls===1?{user:100,system:100}:{user:0,system:0});check(reset.state.lastCpuMs===0);
const quota=await scenario(()=>({user:0,system:0}),true);check(quota.writes===2);check(quota.state.lastCpuMs===undefined);check(quota.state.completedSlot===undefined);
check(OPS_INTERVALS.financial===300000);
console.log(JSON.stringify({ok:true,checks,realNetworkCalls:0,realDatabaseCalls:0,realBusinessWrites:0,noExtraMetricQueries:true,measurement:'process-wide Node CPU sample; not provider billing'}));
