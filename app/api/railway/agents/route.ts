import {NextResponse} from 'next/server';
import {normalizeStage,safeFailure,type AgentRequestPayload} from '@/lib/railway/agentProtocol';
import {optimizeRemote} from '@/lib/railway/quantumRemote';
import type {AgentDecision,AgentLevel,AgentStageResult,Train} from '@/lib/railway/types';

export const runtime='nodejs';

const LLM_URL=process.env.RUNPOD_LLM_URL;
const MODEL=process.env.RUNPOD_MODEL||'local-model';
const API_KEY=process.env.RUNPOD_API_KEY||'';
const LOCAL_BATCH_SIZE=4;
const REGIONAL_BATCH_SIZE=4;
const SUPERVISOR_BATCH_SIZE=4;

// A single 30B Ollama model should not receive several generations at once.
// Requests may arrive concurrently from the UI, but actual LLM generations are serialized here.
let llmTail:Promise<void>=Promise.resolve();
async function withLlmSlot<T>(fn:()=>Promise<T>):Promise<T>{
 let release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const previous=llmTail;
 llmTail=previous.then(()=>gate);
 await previous;
 try{return await fn();}finally{release();}
}

function jsonFromText(text:string){
 const cleaned=text.trim().replace(/^```json\s*/i,'').replace(/^```/,'').replace(/```$/,'').trim();
 const start=cleaned.indexOf('{'),end=cleaned.lastIndexOf('}');
 if(start<0||end<start)throw new Error('LLM did not return a JSON object.');
 return JSON.parse(cleaned.slice(start,end+1));
}

function chunk<T>(items:T[],size:number):T[][]{
 const out:T[][]=[];
 for(let i=0;i<items.length;i+=size)out.push(items.slice(i,i+size));
 return out;
}

function unique(ids:string[]):string[]{return [...new Set(ids)];}

async function mapLimited<T,R>(items:T[],limit:number,fn:(item:T,index:number)=>Promise<R>):Promise<R[]>{
 const results=new Array<R>(items.length);
 let cursor=0;
 const worker=async()=>{
  while(true){
   const index=cursor++;
   if(index>=items.length)return;
   results[index]=await fn(items[index],index);
  }
 };
 await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));
 return results;
}

function sortIdsByPosition(payload:AgentRequestPayload,ids:string[]):string[]{
 const byId=new Map(payload.trains.map(t=>[t.id,t]));
 return [...ids].sort((a,b)=>{
  const aa=byId.get(a),bb=byId.get(b);
  if(!aa||!bb)return a.localeCompare(b);
  return aa.x-bb.x||aa.lane-bb.lane||aa.id.localeCompare(bb.id);
 });
}

// LOCAL agents should see their own geographic cell plus nearby trains/conflict partners,
// rather than receiving all 48 services for every decision.
function scopedPayload(payload:AgentRequestPayload,requestedTrainIds:string[],radius:number):AgentRequestPayload{
 const requested=new Set(requestedTrainIds);
 const focus=payload.trains.filter(t=>requested.has(t.id));
 const visible=new Set(requestedTrainIds);

 for(const train of payload.trains){
  if(focus.some(f=>f.lane===train.lane&&Math.abs(f.x-train.x)<=radius))visible.add(train.id);
 }
 for(const conflict of payload.conflicts.filter(c=>!c.resolved)){
  if(conflict.trains.some(id=>visible.has(id)||requested.has(id)))for(const id of conflict.trains)visible.add(id);
 }

 const focusStations=new Set(focus.map(t=>t.plannedStation).filter(Boolean));
 return {
  ...payload,
  trains:payload.trains.filter(t=>visible.has(t.id)),
  conflicts:payload.conflicts.filter(c=>c.trains.some(id=>visible.has(id))),
  reservations:payload.reservations.filter(r=>visible.has(r.trainId)||focusStations.has(r.station)),
  requestedTrainIds
 };
}

function ollamaNativeUrl(raw:string):string|null{
 try{
  const u=new URL(raw);
  if(u.port==='11434'||u.hostname.includes('-11434.')||u.pathname.includes('/v1/chat/completions')){
   u.pathname='/api/chat';u.search='';u.hash='';return u.toString();
  }
 }catch{}
 return null;
}

function decisionSchema(requestedTrainIds:string[]){
 return {
  type:'object',
  properties:{
   summary:{type:'string'},
   decisions:{
    type:'array',minItems:requestedTrainIds.length,maxItems:requestedTrainIds.length,
    items:{
     type:'object',
     properties:{
      trainId:{type:'string',enum:requestedTrainIds},
      action:{type:'string',enum:['PROCEED','HOLD','ESCALATE']},
      reason:{type:'string'},
      holdSeconds:{type:'number',minimum:0,maximum:900}
     },
     required:['trainId','action','reason'],additionalProperties:false
    }
   }
  },
  required:['summary','decisions'],additionalProperties:false
 };
}

async function callAgent(level:AgentLevel,system:string,input:any,requestedTrainIds:string[],maxTokens=500):Promise<AgentStageResult>{
 if(!LLM_URL)throw new Error('RUNPOD_LLM_URL is not configured.');
 const queuedAt=performance.now();
 return withLlmSlot(async()=>{
  const started=performance.now();
  const queueMs=started-queuedAt;
  console.info(`[RailAI] ${level} -> RunPod · ${requestedTrainIds.join(', ')} · queue ${Math.round(queueMs)} ms`);
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),90000);
  try{
   const native=ollamaNativeUrl(LLM_URL);
   let content:string|undefined;
   if(native){
    const response=await fetch(native,{method:'POST',headers:{'content-type':'application/json',...(API_KEY?{authorization:`Bearer ${API_KEY}`}:{})},body:JSON.stringify({
     model:MODEL,
     stream:false,
     think:false,
     format:decisionSchema(requestedTrainIds),
     options:{temperature:0,num_predict:maxTokens},
     messages:[{role:'system',content:system},{role:'user',content:JSON.stringify(input)}]
    }),signal:controller.signal,cache:'no-store'});
    if(!response.ok)throw new Error(`Ollama HTTP ${response.status}: ${(await response.text()).slice(0,240)}`);
    const payload=await response.json() as any;
    content=payload?.message?.content;
   }else{
    const response=await fetch(LLM_URL,{method:'POST',headers:{'content-type':'application/json',...(API_KEY?{authorization:`Bearer ${API_KEY}`}:{})},body:JSON.stringify({
     model:MODEL,temperature:0,max_tokens:maxTokens,
     response_format:{type:'json_schema',json_schema:{name:'railai_decisions',strict:true,schema:decisionSchema(requestedTrainIds)}},
     messages:[{role:'system',content:system},{role:'user',content:JSON.stringify(input)}]
    }),signal:controller.signal,cache:'no-store'});
    if(!response.ok)throw new Error(`LLM HTTP ${response.status}: ${(await response.text()).slice(0,240)}`);
    const payload=await response.json() as any;
    content=payload?.choices?.[0]?.message?.content;
   }
   if(typeof content!=='string')throw new Error('LLM response missing message content.');
   const stage=normalizeStage(level,jsonFromText(content),requestedTrainIds,MODEL,performance.now()-queuedAt);
   if(!stage.ok)throw new Error(`${level} returned ${stage.decisions.length}/${requestedTrainIds.length} valid decisions.`);
   console.info(`[RailAI] ${level} <- RunPod · ${requestedTrainIds.length} decisions · ${Math.round(performance.now()-started)} ms generation`);
   return stage;
  }catch(error){
   console.error(`[RailAI] ${level} RunPod error:`,error);
   throw error;
  }finally{clearTimeout(timer);}
 });
}
function failedStage(level:AgentLevel,requestedTrainIds:string[],error:unknown):AgentStageResult{
 const message=error instanceof Error?error.message:String(error);
 return {
  level,
  ok:false,
  model:MODEL,
  summary:`${level} batch failed (${requestedTrainIds.length} trains): ${message.slice(0,260)}. Only this batch is fail-safe held.`,
  decisions:requestedTrainIds.map(trainId=>({trainId,action:'HOLD' as const,reason:`${level} batch unavailable; fail-safe hold.`}))
 };
}

async function callAgentSafe(level:AgentLevel,system:string,input:any,requestedTrainIds:string[],maxTokens=900):Promise<AgentStageResult>{
 try{return await callAgent(level,system,input,requestedTrainIds,maxTokens);}
 catch(error){return failedStage(level,requestedTrainIds,error);}
}

const common=`You are part of RailAI, a railway dispatch research simulator. Return JSON only with keys summary and decisions. decisions must contain EXACTLY one object for every train in requestedTrainIds and no other trains. Each object is {trainId, action, reason, holdSeconds?}. action is exactly PROCEED, HOLD, or ESCALATE. Never invent train IDs. Keep summary under 25 words and each reason under 18 words. IMPORTANT: deterministic routing/interlocking already controls movement, platform reservations and safe spacing. Prefer PROCEED when a safe reserved route exists. HOLD only when there is a real unresolved no-path/resource conflict; keep holds short. ESCALATE only genuinely connected corridor problems. This is a simulation, not real railway authority.`;

function deterministicSafety(payload:AgentRequestPayload,decisions:AgentDecision[]):AgentDecision[]{
 const byId=new Map(decisions.map(d=>[d.trainId,d]));
 for(const id of payload.requestedTrainIds){if(!byId.has(id))byId.set(id,{trainId:id,action:'PROCEED',reason:'Deterministic controller retained movement because the hierarchy omitted this train.'});}
 for(const id of payload.requestedTrainIds){
  const train=payload.trains.find(t=>t.id===id);if(!train)continue;
  if(payload.blocked.includes(train.lane)){
   const inOrNearBlock=train.direction===1?(train.x>850&&train.x<995):(train.x<1040&&train.x>895);
   if(inOrNearBlock)byId.set(id,{trainId:id,action:'HOLD',holdSeconds:20,reason:'Deterministic safety: blocked section still lies on the active route.'});
  }
  if(payload.closedPlatform&&train.plannedStation==='dusseldorf'&&train.plannedPlatform===10){
   byId.set(id,{trainId:id,action:'HOLD',holdSeconds:20,reason:'Deterministic safety: Düsseldorf platform 10 remains on this route.'});
  }
 }
 // Close following is speed-regulated continuously. HOLD only inside the actual minimum separation envelope.
 const requested=payload.trains.filter(t=>payload.requestedTrainIds.includes(t.id));
 for(const a of requested){
  for(const b of payload.trains){
   if(a.id===b.id||a.lane!==b.lane||a.direction!==b.direction)continue;
   const signed=(b.x-a.x)*a.direction;
   const minimum=14+Math.min(8,(a.type==='ICE'?190:a.type==='S'?100:a.type==='RB'?130:140)/30);
   if(signed>0&&signed<minimum)byId.set(a.id,{trainId:a.id,action:'HOLD',holdSeconds:12,reason:`Deterministic safety: ${b.id} is inside minimum separation.`});
  }
 }
 return payload.requestedTrainIds.map(id=>byId.get(id)!);
}

function reconstructTrains(payload:AgentRequestPayload):Train[]{
 return payload.trains.map(t=>({id:t.id,type:t.type,lane:t.lane,x:t.x,direction:t.direction,cruise:t.type==='ICE'?190:t.type==='S'?100:t.type==='RB'?130:140,speed:t.speed,delay:t.delay,hold:0,dwell:0,visited:[],source:'SIMULATED',status:t.status,origin:t.direction===1?'koln':'dortmund',destination:t.direction===1?'dortmund':'koln',serviceLine:t.line,headwayMinutes:t.line==='S 11'?20:30,cycle:0,authority:t.authority,authorityReason:'',plannedStation:t.plannedStation,plannedPlatform:t.plannedPlatform,plannedLane:t.plannedLane}));
}

function putDecisions(target:Map<string,AgentDecision>,stage:AgentStageResult){
 for(const d of stage.decisions)target.set(d.trainId,d);
}

export async function GET(){
 if(!LLM_URL)return NextResponse.json({ok:false,configured:false,reachable:false,model:MODEL,message:'RUNPOD_LLM_URL is not configured.'},{status:503});
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),7000);const started=performance.now();
 try{
  const native=ollamaNativeUrl(LLM_URL);
  if(native){
   const u=new URL(native);u.pathname='/api/tags';u.search='';u.hash='';
   const response=await fetch(u,{headers:{...(API_KEY?{authorization:`Bearer ${API_KEY}`}:{})},signal:controller.signal,cache:'no-store'});
   if(!response.ok)throw new Error(`Ollama health HTTP ${response.status}`);
   const payload=await response.json() as any;
   const models=(payload?.models??[]).map((m:any)=>String(m?.name||m?.model||'')).filter(Boolean);
   const modelAvailable=models.some((name:string)=>name===MODEL||name.startsWith(`${MODEL}:`)||MODEL.startsWith(`${name}:`));
   return NextResponse.json({ok:true,configured:true,reachable:true,model:MODEL,modelAvailable,latencyMs:Math.round(performance.now()-started),message:`RunPod reachable · ${MODEL}${modelAvailable?' loaded/available':' endpoint online'}`});
  }
  const u=new URL(LLM_URL);u.pathname=u.pathname.replace(/\/chat\/completions\/?$/,'/models');u.search='';u.hash='';
  const response=await fetch(u,{headers:{...(API_KEY?{authorization:`Bearer ${API_KEY}`}:{})},signal:controller.signal,cache:'no-store'});
  if(!response.ok)throw new Error(`Model endpoint health HTTP ${response.status}`);
  return NextResponse.json({ok:true,configured:true,reachable:true,model:MODEL,modelAvailable:true,latencyMs:Math.round(performance.now()-started),message:`RunPod reachable · ${MODEL}`});
 }catch(error:any){
  const message=error?.name==='AbortError'?'RunPod health check timed out.':String(error?.message||error);
  return NextResponse.json({ok:false,configured:true,reachable:false,model:MODEL,message},{status:503});
 }finally{clearTimeout(timer);}
}

export async function POST(request:Request){
 const decisionId=`agent-${Date.now().toString(36)}`;let requestedTrainIds:string[]=[];
 try{
  const payload=await request.json() as AgentRequestPayload;
  if(!Array.isArray(payload.requestedTrainIds)||!payload.requestedTrainIds.length)return NextResponse.json(safeFailure(decisionId,[],'No pending trains requested.'),{status:400});
  requestedTrainIds=sortIdsByPosition(payload,unique(payload.requestedTrainIds).slice(0,48));

  // LOCAL: the browser sends small groups (normally four trains).
  // Any accidental larger request is processed as small batches through the serialized model queue.
  const localBatches=chunk(requestedTrainIds,LOCAL_BATCH_SIZE);
  const localStages=await mapLimited(localBatches,1,(ids,index)=>callAgentSafe(
   'LOCAL',
   `${common}\nRole: local station controller cell ${index+1}/${localBatches.length}. Decide only your requested trains using immediate station/headway conditions. PROCEED normal safe movements locally; ESCALATE only when corridor coordination is genuinely needed.`,
   scopedPayload(payload,ids,140),
   ids,
   450
  ));
  const localDecisions=new Map<string,AgentDecision>();localStages.forEach(s=>putDecisions(localDecisions,s));

  // MOTHER / REGIONAL: only trains involved in active conflicts, infrastructure restrictions,
  // or explicitly escalated by a local controller are promoted upward.
  const activeConflictIds=payload.conflicts.filter(c=>!c.resolved).flatMap(c=>c.trains);
  const infrastructureIds=payload.trains.filter(t=>payload.blocked.includes(t.lane)||(payload.closedPlatform&&t.plannedStation==='dusseldorf'&&t.plannedPlatform===10)).map(t=>t.id);
  const localEscalations=localStages.flatMap(s=>s.decisions.filter(d=>d.action==='ESCALATE').map(d=>d.trainId));
  const regionalIds=sortIdsByPosition(payload,unique([...activeConflictIds,...infrastructureIds,...localEscalations]).filter(id=>requestedTrainIds.includes(id)));
  const regionalBatches=chunk(regionalIds,REGIONAL_BATCH_SIZE);
  const regionalStages=await mapLimited(regionalBatches,2,(ids,index)=>callAgentSafe(
   'REGIONAL',
   `${common}\nRole: regional corridor coordinator ${index+1}/${Math.max(1,regionalBatches.length)}. You receive only trains that need coordination. Review the local decisions, downstream conflicts, cadence and competing services. Resolve locally when possible; ESCALATE only network-wide/high-severity clusters.`,
   {...scopedPayload(payload,ids,320),local:localStages.map(s=>({ok:s.ok,summary:s.summary,decisions:s.decisions.filter(d=>ids.includes(d.trainId))}))},
   ids,
   500
  ));
  const regionalDecisions=new Map<string,AgentDecision>();regionalStages.forEach(s=>putDecisions(regionalDecisions,s));

  // GRANDMA / SUPERVISOR: only high-severity conflicts or explicit REGIONAL escalations arrive here.
  const highConflictIds=payload.conflicts.filter(c=>!c.resolved&&c.severity==='high').flatMap(c=>c.trains).filter(id=>requestedTrainIds.includes(id));
  const regionalEscalations=regionalStages.flatMap(s=>s.decisions.filter(d=>d.action==='ESCALATE').map(d=>d.trainId));
  const criticalIds=sortIdsByPosition(payload,unique([...highConflictIds,...regionalEscalations]));

  let quantum=null;
  let quantumError='';
  let quantumIds:string[]=[];
  if(criticalIds.length){
   const focusX=criticalIds.map(id=>payload.trains.find(t=>t.id===id)?.x).filter((x):x is number=>typeof x==='number');
   const center=focusX.length?focusX.reduce((a,b)=>a+b,0)/focusX.length:750;
   const contextIds=[...payload.trains].sort((a,b)=>Math.abs(a.x-center)-Math.abs(b.x-center)).map(t=>t.id);
   quantumIds=unique([...criticalIds,...regionalIds,...contextIds]).slice(0,3);
   if(quantumIds.length===3){
    try{quantum=await optimizeRemote(reconstructTrains(payload),512,42,quantumIds);}
    catch(error){quantumError=error instanceof Error?error.message:String(error);}
   }
  }

  // If the fixed 9-qubit solver needed a third context train, Grandma reviews that train too,
  // so the QAOA release order can never bypass the hierarchy.
  const supervisorIds=sortIdsByPosition(payload,unique([...criticalIds,...quantumIds]).filter(id=>requestedTrainIds.includes(id)));
  const supervisorBatches=chunk(supervisorIds,SUPERVISOR_BATCH_SIZE);
  const supervisorStages=await mapLimited(supervisorBatches,1,(ids,index)=>callAgentSafe(
   'SUPERVISOR',
   `${common}\nRole: network supervisor ${index+1}/${Math.max(1,supervisorBatches.length)}. These are the only network-level problem trains. Produce FINAL decisions. The QAOA result is a candidate release order, never a safety override. Do not return ESCALATE; choose PROCEED or HOLD.`,
   {...scopedPayload(payload,ids,700),regional:regionalStages.map(s=>({ok:s.ok,summary:s.summary,decisions:s.decisions.filter(d=>ids.includes(d.trainId))})),quantum:quantum?{labels:quantum.labels,classical:quantum.classical,quantum:quantum.quantum,feasibility:quantum.feasibility,shots:quantum.shots}:null,quantumError:quantumError||null},
   ids,
   500
  ));
  const supervisorDecisions=new Map<string,AgentDecision>();supervisorStages.forEach(s=>putDecisions(supervisorDecisions,s));

  // Lowest level that safely resolved a train wins unless a higher level reviewed it.
  const hierarchy=new Map<string,AgentDecision>();
  for(const id of requestedTrainIds){
   const local=localDecisions.get(id);
   if(local)hierarchy.set(id,local);
  }
  for(const id of regionalIds){const regional=regionalDecisions.get(id);if(regional)hierarchy.set(id,regional);}
  for(const id of supervisorIds){const supervisor=supervisorDecisions.get(id);if(supervisor)hierarchy.set(id,supervisor);}

  const supervisorSet=new Set(supervisorIds);
  const hierarchyDecisions=requestedTrainIds.map(id=>{
   if(quantumError&&supervisorSet.has(id))return {trainId:id,action:'HOLD' as const,reason:`QAOA service unavailable for this network-level conflict; fail-safe hold. ${quantumError.slice(0,180)}`};
   const d=hierarchy.get(id)??{trainId:id,action:'HOLD' as const,reason:'No hierarchy decision returned; fail-safe hold.'};
   return d.action==='ESCALATE'?{...d,action:'HOLD' as const,reason:`${d.reason} Unresolved escalation is converted to fail-safe HOLD.`}:d;
  });
  const finalDecisions=deterministicSafety({...payload,requestedTrainIds},hierarchyDecisions);
  const stages=[...localStages,...regionalStages,...supervisorStages];
  const anyLiveStage=stages.some(s=>s.ok);
  if(!anyLiveStage)return NextResponse.json(safeFailure(decisionId,requestedTrainIds,'Every live-agent batch failed; all trains remain fail-safe held.'),{status:503});

  return NextResponse.json({ok:true,decisionId,requestedTrainIds,stages,finalDecisions,quantum});
 }catch(error:any){
  const message=error?.name==='AbortError'?'RunPod/quantum request timed out.':String(error?.message||error);
  return NextResponse.json(safeFailure(decisionId,requestedTrainIds,message),{status:503});
 }
}
