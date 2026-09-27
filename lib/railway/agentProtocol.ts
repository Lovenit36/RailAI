import type {AgentAction,AgentCycleResponse,AgentDecision,AgentLevel,AgentStageResult,Conflict,PlatformReservation,Simulation,StationId,Train} from './types';

export interface CompactTrain {id:string;type:Train['type'];line:string;lane:number;x:number;direction:1|-1;speed:number;delay:number;status:Train['status'];authority:Train['authority'];plannedStation?:StationId;plannedPlatform?:number;plannedLane?:number;}
export interface AgentRequestPayload {time:number;trains:CompactTrain[];conflicts:Pick<Conflict,'id'|'type'|'severity'|'trains'|'lane'|'x'|'resolved'>[];blocked:number[];closedPlatform:boolean;reservations:PlatformReservation[];requestedTrainIds:string[];}

export function compactAgentPayload(state:Simulation,requestedTrainIds:string[]):AgentRequestPayload{
 return {
  time:state.time,
  trains:state.trains.map(t=>({id:t.id,type:t.type,line:t.serviceLine,lane:t.lane,x:Number(t.x.toFixed(2)),direction:t.direction,speed:Math.round(t.speed),delay:Math.round(t.delay),status:t.status,authority:t.authority,plannedStation:t.plannedStation,plannedPlatform:t.plannedPlatform,plannedLane:t.plannedLane})),
  conflicts:state.conflicts.filter(c=>!c.resolved).map(c=>({id:c.id,type:c.type,severity:c.severity,trains:c.trains,lane:c.lane,x:Number(c.x.toFixed(2)),resolved:c.resolved})),
  blocked:[...state.blocked],closedPlatform:state.closedPlatform,reservations:state.platformReservations.map(r=>({...r})),requestedTrainIds
 };
}

export function isAgentAction(v:unknown):v is AgentAction{return v==='PROCEED'||v==='HOLD'||v==='ESCALATE';}
export function normalizeStage(level:AgentLevel,raw:any,requestedTrainIds:string[],model?:string,latencyMs?:number):AgentStageResult{
 const allowed=new Set(requestedTrainIds),byId=new Map<string,AgentDecision>();
 if(Array.isArray(raw?.decisions))for(const d of raw.decisions){if(!d||!allowed.has(String(d.trainId))||!isAgentAction(d.action))continue;byId.set(String(d.trainId),{trainId:String(d.trainId),action:d.action,reason:String(d.reason||'No explanation supplied.'),holdSeconds:Number.isFinite(Number(d.holdSeconds))?Math.max(0,Math.min(900,Number(d.holdSeconds))):undefined});}
 const decisions=requestedTrainIds.flatMap(id=>byId.has(id)?[byId.get(id)!]:[]);
 return {level,ok:decisions.length===requestedTrainIds.length,model,latencyMs,summary:String(raw?.summary||`${level} returned ${decisions.length}/${requestedTrainIds.length} decisions.`).slice(0,500),decisions};
}

export function safeFailure(decisionId:string,requestedTrainIds:string[],error:string):AgentCycleResponse{
 return {ok:false,decisionId,requestedTrainIds,stages:[],finalDecisions:requestedTrainIds.map(trainId=>({trainId,action:'PROCEED',reason:'Live-agent response unavailable; deterministic safety controller remains in charge.'})),quantum:null,error};
}
