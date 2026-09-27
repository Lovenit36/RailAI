'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {initialSimulation,tick,injectScenario,resolveConflict,applyOrder,applyAgentCycle} from './simulation';
import {compactAgentPayload} from './agentProtocol';
import type {AgentCycleResponse,AgentStageResult,QuantumResult,Scenario,Simulation,Snapshot} from './types';

export interface AgentRuntimeState {
 status:'idle'|'requesting'|'online'|'error';
 endpoint:'checking'|'online'|'offline';
 endpointMessage:string;
 endpointLatencyMs:number;
 activeTrainIds:string[];
 lastError:string;
 lastDecisionId:string;
 stages:AgentStageResult[];
 quantum:QuantumResult|null;
 lastRunAt:number;
}

const EMPTY_AGENT:AgentRuntimeState={
 status:'idle',endpoint:'checking',endpointMessage:'Checking RunPod…',endpointLatencyMs:0,activeTrainIds:[],
 lastError:'',lastDecisionId:'',stages:[],quantum:null,lastRunAt:0
};

export function useSimulation(){
 const [simulation,setSimulation]=useState(initialSimulation),[running,setRunning]=useState(true),[speed,setSpeed]=useState(5),[mode,setMode]=useState<'simulation'|'replay'>('simulation'),[replayIndex,setReplayIndex]=useState(0);
 const [agent,setAgent]=useState<AgentRuntimeState>(EMPTY_AGENT);
 const history=useRef<Snapshot[]>([]),simRef=useRef(simulation),lastRecord=useRef(0),indexRef=useRef(0),epoch=useRef(0);
 const requestSequence=useRef(0),inFlightAuthorities=useRef(new Map<string,number>()),retryAfter=useRef(new Map<string,number>()),activeRequests=useRef(new Set<number>()),activeKinds=useRef(new Map<number,'normal'|'critical'>());
 simRef.current=simulation;indexRef.current=replayIndex;
 useEffect(()=>{if(!history.current.length)history.current=[{time:simRef.current.time,state:simRef.current}];},[]);

 useEffect(()=>{
  let cancelled=false;
  const check=async()=>{
   const started=performance.now();
   try{
    const response=await fetch('/api/railway/agents',{cache:'no-store'});
    const data=await response.json() as {reachable?:boolean;model?:string;message?:string;modelAvailable?:boolean};
    if(cancelled)return;
    const online=response.ok&&data.reachable===true;
    setAgent(a=>({...a,endpoint:online?'online':'offline',endpointLatencyMs:performance.now()-started,endpointMessage:data.message||(online?`RunPod reachable · ${data.model??'model detected'}`:'RunPod health check failed')}));
   }catch(error:any){
    if(cancelled)return;
    setAgent(a=>({...a,endpoint:'offline',endpointLatencyMs:performance.now()-started,endpointMessage:String(error?.message||error)}));
   }
  };
  void check();const timer=setInterval(check,15000);
  return()=>{cancelled=true;clearInterval(timer);};
 },[]);

 useEffect(()=>{
  if(!running)return;
  let previous=performance.now(),replayTime=history.current[indexRef.current]?.time??0;
  const timer=setInterval(()=>{
   const now=performance.now(),elapsed=Math.min((now-previous)/1000,.5);previous=now;
   if(mode==='replay'){
    replayTime+=elapsed*speed;let nextIndex=indexRef.current;
    while(nextIndex<history.current.length-1&&history.current[nextIndex+1].time<=replayTime)nextIndex++;
    if(nextIndex!==indexRef.current){indexRef.current=nextIndex;setReplayIndex(nextIndex);}
    if(nextIndex>=history.current.length-1)setRunning(false);
    return;
   }
   const next=tick(simRef.current,elapsed*speed);simRef.current=next;
   if(next.time-lastRecord.current>=3){history.current.push({time:next.time,state:next});if(history.current.length>1200)history.current.shift();lastRecord.current=next.time;}
   setSimulation(next);
  },100);
  return()=>clearInterval(timer);
 },[running,speed,mode]);

 const invalidateAgentRequests=useCallback(()=>{
  epoch.current++;
  inFlightAuthorities.current.clear();
  retryAfter.current.clear();
  activeRequests.current.clear();
  activeKinds.current.clear();
 },[]);

 const mutate=useCallback((fn:(s:Simulation)=>Simulation,invalidatesAgent=false)=>{
  if(invalidatesAgent)invalidateAgentRequests();
  const next=fn(simRef.current);simRef.current=next;history.current.push({time:next.time,state:next});setSimulation(next);
 },[invalidateAgentRequests]);

 useEffect(()=>{
  if(mode!=='simulation')return;
  let cancelled=false;
  const MAX_PARALLEL_AGENT_REQUESTS=2;
  const NORMAL_BATCH_SIZE=4;
  const CRITICAL_BATCH_SIZE=2;
  const RETRY_DELAY_MS=10000;

  const runGroup=async(ids:string[],kind:'normal'|'critical')=>{
   const token=++requestSequence.current;
   const requestEpoch=epoch.current;
   for(const id of ids)inFlightAuthorities.current.set(id,token);
   activeRequests.current.add(token);activeKinds.current.set(token,kind);
   setAgent(a=>({...a,status:'requesting',lastError:'',activeTrainIds:[...new Set([...a.activeTrainIds,...ids])]}));

   try{
    const payload=compactAgentPayload(simRef.current,ids);
    const response=await fetch('/api/railway/agents',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),cache:'no-store'});
    const data=await response.json() as AgentCycleResponse;
    if(cancelled||requestEpoch!==epoch.current)return;
    if(!response.ok||!data.ok)throw new Error(data.error||`Agent API HTTP ${response.status}`);

    for(const id of ids)retryAfter.current.delete(id);
    const next=applyAgentCycle(simRef.current,data);simRef.current=next;history.current.push({time:next.time,state:next});setSimulation(next);
    setAgent(a=>({...a,lastError:'',lastDecisionId:data.decisionId,stages:[...a.stages,...data.stages].slice(-32),quantum:data.quantum??a.quantum,lastRunAt:Date.now()}));
   }catch(error:any){
    if(!cancelled&&requestEpoch===epoch.current){
     const retryAt=Date.now()+RETRY_DELAY_MS;for(const id of ids)retryAfter.current.set(id,retryAt);
     setAgent(a=>({...a,lastError:String(error?.message||error),lastRunAt:Date.now()}));
    }
   }finally{
    activeRequests.current.delete(token);activeKinds.current.delete(token);
    for(const id of ids)if(inFlightAuthorities.current.get(id)===token)inFlightAuthorities.current.delete(id);
    if(!cancelled&&requestEpoch===epoch.current)setAgent(a=>{
     const remaining=a.activeTrainIds.filter(id=>!ids.includes(id));
     return {...a,activeTrainIds:remaining,status:activeRequests.current.size?'requesting':a.lastError?'error':'online'};
    });
   }
  };

  const poll=setInterval(()=>{
   if(cancelled||activeRequests.current.size>=MAX_PARALLEL_AGENT_REQUESTS)return;
   const current=simRef.current;
   const now=Date.now();
   const pendingTrains=current.trains.filter(t=>t.authority==='pending'&&!inFlightAuthorities.current.has(t.id)&&(retryAfter.current.get(t.id)??0)<=now);
   if(!pendingTrains.length)return;

   // Keep one small ordinary movement request and one conflict request at most.
   // This prevents a 30B Ollama model from being flooded with 48 trains at startup,
   // while still allowing normal services to begin moving before a slow conflict/QAOA chain finishes.
   const conflictIds=new Set(current.conflicts.filter(c=>!c.resolved).flatMap(c=>c.trains));
   const critical=pendingTrains.filter(t=>conflictIds.has(t.id)||current.blocked.includes(t.lane)||(current.closedPlatform&&t.plannedStation==='dusseldorf'&&t.plannedPlatform===10)).map(t=>t.id);
   const criticalSet=new Set(critical);
   const normal=pendingTrains.filter(t=>!criticalSet.has(t.id)).map(t=>t.id);
   const kinds=[...activeKinds.current.values()];

   // Launch normal first so the railway visibly starts as soon as the first LOCAL response arrives.
   if(normal.length&&!kinds.includes('normal')&&activeRequests.current.size<MAX_PARALLEL_AGENT_REQUESTS){
    void runGroup(normal.slice(0,NORMAL_BATCH_SIZE),'normal');
   }
   const afterNormalKinds=[...activeKinds.current.values()];
   if(critical.length&&!afterNormalKinds.includes('critical')&&activeRequests.current.size<MAX_PARALLEL_AGENT_REQUESTS){
    void runGroup(critical.slice(0,CRITICAL_BATCH_SIZE),'critical');
   }
  },350);
  return()=>{cancelled=true;clearInterval(poll);};
 },[mode]);

 const reset=()=>{invalidateAgentRequests();const s=initialSimulation();simRef.current=s;setSimulation(s);history.current=[{time:s.time,state:s}];lastRecord.current=0;setReplayIndex(0);indexRef.current=0;setMode('simulation');setRunning(true);setAgent(a=>({...EMPTY_AGENT,endpoint:a.endpoint,endpointMessage:a.endpointMessage,endpointLatencyMs:a.endpointLatencyMs}));};
 const changeMode=(m:'simulation'|'replay')=>{invalidateAgentRequests();setRunning(false);setMode(m);if(m==='replay'){setReplayIndex(0);indexRef.current=0;}};
 return {state:mode==='replay'?(history.current[replayIndex]?.state??simulation):simulation,running,setRunning,speed,setSpeed,mode,changeMode,history:history.current,replayIndex,setReplayIndex,reset,agent,pendingAuthorities:(mode==='simulation'?simulation:history.current[replayIndex]?.state??simulation).trains.filter(t=>t.authority==='pending').length,inject:(sc:Scenario)=>mutate(s=>injectScenario(s,sc),true),resolve:(id:string)=>mutate(s=>resolveConflict(s,id),true),applySchedule:(order:string[])=>mutate(s=>applyOrder(s,order),true)};
}
