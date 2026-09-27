import {BASE_TIME,directionLanes,nextStation,platformFor,platformForLane,platformIndex,reachablePlatforms,stations} from './network';
import {generateSyntheticTrains,SYNTHETIC_SERVICE_COUNT} from './syntheticDataset';
import type {AgentCycleResponse,ArrivalPrediction,Conflict,DecisionEvent,PlatformReservation,Scenario,Simulation,Station,Train} from './types';

const PLATFORM_PLAN_DISTANCE=360;
const PLATFORM_ROUTE_LOCK_DISTANCE=185;
const PLATFORM_THROAT_DISTANCE=185;
const PLATFORM_ROUTE_OCCUPANCY_DISTANCE=175;
const DIVERGING_APPROACH_DISTANCE=275;
const DIVERGING_APPROACH_SPEED=105;
const DIVERGING_SWITCH_SPEED=65;
const PLATFORM_CLEARANCE_SECONDS=55;
const PLATFORM_BLOCK_LENGTH=150;
const HEADWAY_WARNING_MARGIN=34;
const AGENT_HEADWAY_MARGIN=8;
const REROUTE_COOLDOWN=45;
const RUNNING_SWITCH_RADIUS=24;

export function initialSimulation():Simulation {
 const trains=generateSyntheticTrains();
 const critical=new Set(['ICE 618','ICE 620']);
 for(const train of trains){
  if(critical.has(train.id)){
   train.authority='pending';
   train.authorityReason='Initial close-headway cluster queued for live agent review; deterministic movement remains active.';
  }
 }
 return {
  time:BASE_TIME,
  trains,
  blocked:[],
  closedPlatform:false,
  platformReservations:[],
  routeChanges:0,
  resolutions:0,
  totalHeld:0,
  conflicts:[{id:'initial-headway',type:'headway',title:'Closing headway at Düsseldorf',detail:'ICE 618 is following ICE 620 closely. The movement controller regulates spacing while the live hierarchy and QUBO/QAOA review the release order.',station:'dusseldorf',trains:['ICE 618','ICE 620'],severity:'high',created:BASE_TIME,lane:2,x:660,resolved:false}],
  events:[
   {id:'start',time:BASE_TIME,level:'SYSTEM',text:`Synthetic recurring corridor started · ${SYNTHETIC_SERVICE_COUNT} active services · continuous deterministic movement is active.`},
   {id:'agent-init',time:BASE_TIME,level:'SON',text:'Agents now review exceptions and conflicts; trains do not wait for an LLM to move through normal clear track.'}
  ]
 };
}

export function logEvent(s:Simulation,level:DecisionEvent['level'],text:string):DecisionEvent[]{return [...s.events,{id:`${s.time}-${s.events.length}-${level}`,time:s.time,level,text}].slice(-200);}

const appendEvent=(events:DecisionEvent[],time:number,level:DecisionEvent['level'],text:string)=>[...events,{id:`${time}-${events.length}-${level}-${Math.round(time*10)}`,time,level,text}].slice(-200);
const platformClosed=(s:Simulation,station:Station,platform:number)=>s.closedPlatform&&station.id==='dusseldorf'&&platform===10;
const overlaps=(a0:number,a1:number,b0:number,b1:number)=>a0<b1&&b0<a1;
const dwellSeconds=(t:Train)=>t.type==='S'?30:45;
export const requiredHeadwayGap=(t:Train)=>PLATFORM_BLOCK_LENGTH+Math.min(8,Math.max(0,t.speed-80)*.06);
const safeGap=requiredHeadwayGap;


function stationRouteSplit(train:Train){
 const station=train.plannedStation?stations.find(st=>st.id===train.plannedStation):undefined;
 if(!station||!train.plannedPlatform)return null;
 return {station,split:station.x-train.direction*165};
}

function sharesPhysicalPath(follower:Train,leader:Train){
 if(follower.lane!==leader.lane||follower.direction!==leader.direction)return false;
 const f=stationRouteSplit(follower),l=stationRouteSplit(leader);
 if(!f||!l||f.station.id!==l.station.id||follower.plannedPlatform===leader.plannedPlatform)return true;
 // Until the follower reaches the approach crossover both trains still share the same running line.
 return (follower.x-f.split)*follower.direction<0;
}

function nearStationPlatform(train:Train){return stations.some(st=>Math.abs(train.x-st.x)<120);}

function freeRunTravelSeconds(train:Train,target:Station){
 const distance=Math.max(0,(target.x-train.x)*train.direction);
 const distanceKm=distance*.09;
 const movingSpeed=train.speed>1?Math.min(train.cruise,Math.max(35,(train.speed+train.cruise)/2)):Math.max(30,train.cruise*.55);
 return distanceKm/Math.max(30,movingSpeed)*3600+train.hold+train.dwell;
}

export function predictArrival(s:Simulation,train:Train,target=nextStation(train)):ArrivalPrediction{
 let travelSeconds=freeRunTravelSeconds(train,target);
 let headwayDelaySeconds=0,platformDelaySeconds=0;
 const reasons:string[]=[];
 const ahead=s.trains
  .filter(o=>o.id!==train.id&&sharesPhysicalPath(train,o)&&(o.x-train.x)*train.direction>0)
  .sort((a,b)=>Math.abs(a.x-train.x)-Math.abs(b.x-train.x))[0];
 if(ahead){
  const gap=Math.abs(ahead.x-train.x),minimum=requiredHeadwayGap(train),buffer=minimum+HEADWAY_WARNING_MARGIN;
  if(gap<buffer){
   const deficit=buffer-gap;
   headwayDelaySeconds=Math.min(240,deficit*.09/Math.max(30,ahead.speed||30)*3600);
   reasons.push(`headway behind ${ahead.id} +${Math.round(headwayDelaySeconds)}s`);
  }
 }
 let predicted=s.time+travelSeconds+headwayDelaySeconds;
 const platform=platformFor(train,target);
 const conflicts=s.platformReservations
  .filter(r=>r.station===target.id&&r.platform===platform&&r.trainId!==train.id&&r.until>predicted-35)
  .sort((a,b)=>a.until-b.until);
 if(conflicts.length){
  const clearAt=Math.max(...conflicts.map(r=>r.until));
  platformDelaySeconds=Math.max(0,clearAt-(predicted-35));
  if(platformDelaySeconds>0)reasons.push(`platform ${platform} clears +${Math.round(platformDelaySeconds)}s`);
 }
 predicted+=platformDelaySeconds;
 if(train.hold>0)reasons.unshift(`current hold ${Math.round(train.hold)}s`);
 if(train.dwell>0)reasons.unshift(`current dwell ${Math.round(train.dwell)}s`);
 const confidence:ArrivalPrediction['confidence']=platformDelaySeconds>90||headwayDelaySeconds>120?'LOW':platformDelaySeconds>0||headwayDelaySeconds>0||train.hold>0?'MEDIUM':'HIGH';
 return {station:target.id,etaSeconds:predicted,travelSeconds,headwayDelaySeconds,platformDelaySeconds,confidence,reasons};
}

function runningSwitchPoints(){return stations.flatMap(st=>[st.x-158,st.x+155]);}
function canChangeRunningLaneNow(train:Train){return runningSwitchPoints().some(x=>Math.abs(train.x-x)<=RUNNING_SWITCH_RADIUS);}

function blockAhead(s:Simulation,t:Train,lane=t.lane){
 if(!s.blocked.includes(lane))return false;
 if(t.direction===1)return t.x<982;
 return t.x>906;
}

function localLaneClear(trains:Train[],train:Train,lane:number,radius=55){
 return !trains.some(o=>o.id!==train.id&&o.lane===lane&&Math.abs(o.x-train.x)<radius);
}

function chooseEscapeLane(s:Simulation,trains:Train[],train:Train){
 const ordered=directionLanes(train.direction);
 const here=ordered.indexOf(train.lane);
 return ordered
  .filter((l,i)=>l!==train.lane&&Math.abs(i-here)===1&&!s.blocked.includes(l)&&localLaneClear(trains,train,l,PLATFORM_BLOCK_LENGTH*.72))
  .sort((a,b)=>Math.abs(a-train.lane)-Math.abs(b-train.lane))[0];
}

function applyReactiveReroutes(s:Simulation,trains:Train[],time:number){
 let routeChanges=0;let events=s.events;
 for(const train of trains){
  if(train.hold>0||train.dwell>0||(train.lastRerouteAt!==undefined&&time-train.lastRerouteAt<REROUTE_COOLDOWN))continue;
  const ahead=trains
   .filter(o=>o.id!==train.id&&sharesPhysicalPath(train,o)&&(o.x-train.x)*train.direction>0)
   .sort((a,b)=>Math.abs(a.x-train.x)-Math.abs(b.x-train.x))[0];
  const gap=ahead?Math.abs(ahead.x-train.x):Infinity;
  const blockedSoon=blockAhead(s,train)&&((train.direction===1&&train.x>690)||(train.direction===-1&&train.x<1190));
  // A train held/dwelling inside a station is handled by platform reassignment, not by a fake corridor-lane jump.
  const stoppedAhead=!!ahead&&gap<PLATFORM_BLOCK_LENGTH+45&&(ahead.hold>0||ahead.dwell>0||ahead.speed<2)&&!nearStationPlatform(ahead);
  if(!blockedSoon&&!stoppedAhead)continue;
  if(!canChangeRunningLaneNow(train))continue;
  const alt=chooseEscapeLane(s,trains,train);
  if(alt===undefined)continue;
  const old=train.lane;train.lane=alt;train.plannedLane=alt;train.plannedPlatform=undefined;train.plannedStation=undefined;train.lastRerouteAt=time;
  train.lastRerouteReason=blockedSoon?`Used a physical crossover to avoid blocked lane RR-${old+1}.`:`Used a physical crossover to pass ${ahead?.id??'stopped service'}.`;
  routeChanges++;
  events=appendEvent(events,time,'SON',`${train.id}: physical crossover RR-${old+1} → RR-${alt+1} ${blockedSoon?'before the blocked section':`around ${ahead?.id}`}.`);
 }
 return {trains,events,routeChanges};
}

function buildPlatformPlan(s:Simulation,trains:Train[],time:number,events:DecisionEvent[]){
 const reservations:PlatformReservation[]=[];
 let routeChanges=0;

 // A platform route remains a hard resource from the outer crossover until the train clears the
 // opposite crossover. This prevents a second train (including one from the opposite direction)
 // from entering the same platform path while the first train is still traversing the throat.
 for(const train of trains){
  const station=stations.find(st=>train.plannedStation===st.id&&train.plannedPlatform!==undefined&&Math.abs(train.x-st.x)<PLATFORM_ROUTE_OCCUPANCY_DISTANCE);
  if(!station)continue;
  const platform=platformFor(train,station);
  const atPlatform=Math.abs(train.x-station.x)<30&&(train.dwell>0||train.hold>0||train.status==='Held');
  const conservativeClearance=atPlatform?Math.max(train.dwell,train.hold,5)+PLATFORM_CLEARANCE_SECONDS:180;
  reservations.push({station:station.id,platform,lane:train.lane,trainId:train.id,from:time-5,until:time+conservativeClearance,state:'occupied'});
  train.plannedStation=station.id;train.plannedLane=train.lane;train.plannedPlatform=platform;
 }

 const approaching=trains
  .map(train=>{const station=nextStation(train);const distance=(station.x-train.x)*train.direction;const eta=time+freeRunTravelSeconds(train,station);return {train,station,distance,eta};})
  .filter(x=>x.distance>8&&x.distance<=PLATFORM_PLAN_DISTANCE)
  .sort((a,b)=>a.eta-b.eta||a.distance-b.distance);

 for(const {train,station,distance,eta} of approaching){
  const windowFrom=eta-35,windowUntil=eta+dwellSeconds(train)+PLATFORM_CLEARANCE_SECONDS;
  const basePlatform=platformForLane(station,train.lane),baseIndex=platformIndex(station,basePlatform);
  const previous=train.plannedStation===station.id?train.plannedPlatform:undefined;
  let routeOptions=reachablePlatforms(station,train.lane,distance);
  // Once a route has been selected, keep that platform in the candidate set even as the train
  // gets closer. Inside the last-switch zone the selected route is locked rather than jumping tracks.
  if(previous){
   const previousIndex=platformIndex(station,previous);
   if(previousIndex>=0){
    const previousOption={platform:previous,index:previousIndex,shift:Math.abs(previousIndex-baseIndex)};
    routeOptions=distance<=PLATFORM_ROUTE_LOCK_DISTANCE?[previousOption]:[previousOption,...routeOptions.filter(x=>x.platform!==previous)];
   }
  }
  const candidates=routeOptions
   .filter(x=>!platformClosed(s,station,x.platform))
   .filter(x=>!reservations.some(r=>r.station===station.id&&r.platform===x.platform&&r.trainId!==train.id&&overlaps(windowFrom,windowUntil,r.from,r.until)))
   .map(x=>({platform:x.platform,index:x.index,score:(previous===x.platform?-20:0)+x.shift*7+Math.abs(x.platform-basePlatform)*.35}))
   .sort((a,b)=>a.score-b.score||Math.abs(a.index-baseIndex)-Math.abs(b.index-baseIndex));
  const chosen=candidates[0];
  if(!chosen){train.plannedStation=station.id;train.plannedLane=train.lane;train.plannedPlatform=previous;continue;}

  if(chosen.platform!==basePlatform&&previous!==chosen.platform){
   train.lastRerouteAt=time;train.routeSetAt=time;train.lastRerouteReason=`Platform route ${basePlatform} → ${chosen.platform} selected ${Math.round(distance)} map-units before ${station.short}, before the outer crossover.`;routeChanges++;
   events=appendEvent(events,time,'SON',`${train.id}: ROUTE SET ${station.short} platform ${basePlatform} → ${chosen.platform} with ${Math.round(distance)} map-units of approach remaining; turnout path reserved before the outer crossover.`);
  }
  train.plannedStation=station.id;train.plannedLane=train.lane;train.plannedPlatform=chosen.platform;
  reservations.push({station:station.id,platform:chosen.platform,lane:train.lane,trainId:train.id,from:windowFrom,until:windowUntil,state:'reserved'});
 }
 return {trains,reservations,events,routeChanges};
}

function hasSafeReservation(reservations:PlatformReservation[],train:Train,station:Station){
 return reservations.some(r=>r.trainId===train.id&&r.station===station.id&&r.platform===platformFor(train,station));
}

function platformRouteOwners(trains:Train[]){
 const owners=new Map<string,{id:string;score:number}>();
 for(const train of trains){
  if(!train.plannedStation||train.plannedPlatform===undefined)continue;
  const station=stations.find(st=>st.id===train.plannedStation);if(!station)continue;
  const distance=Math.abs(train.x-station.x);
  if(distance>PLATFORM_THROAT_DISTANCE)continue;
  const key=`${station.id}:${train.plannedPlatform}`;
  const inside=distance<PLATFORM_ROUTE_OCCUPANCY_DISTANCE;
  const score=(inside?0:1000)+distance;
  const current=owners.get(key);
  if(!current||score<current.score)owners.set(key,{id:train.id,score});
 }
 return new Map([...owners].map(([key,value])=>[key,value.id]));
}

function moveTrains(s:Simulation,trains:Train[],reservations:PlatformReservation[],time:number,dt:number){
 const routeOwners=platformRouteOwners(trains);
 return trains.map(t=>{
  const a={...t,visited:[...t.visited]};
  if(a.hold>0){
   a.hold=Math.max(0,a.hold-dt);a.speed=0;a.status='Held';a.delay+=dt;
   if(a.hold===0&&a.authority==='denied'){a.authority='approved';a.authorityReason='Dispatch hold completed; deterministic movement resumed.';}
   return a;
  }
  if(a.dwell>0){a.dwell=Math.max(0,a.dwell-dt);a.speed=0;a.status='Dwelling';return a;}
  if(a.authority==='denied'){a.authority='approved';a.authorityReason='No active hold remains; deterministic movement resumed.';}

  const ahead=trains
   .filter(o=>o.id!==a.id&&sharesPhysicalPath(a,o)&&(o.x-a.x)*a.direction>0)
   .sort((x,y)=>Math.abs(x.x-a.x)-Math.abs(y.x-a.x))[0];
  const gap=ahead?Math.abs(ahead.x-a.x):Infinity;
  const minimum=safeGap(a),warning=minimum+HEADWAY_WARNING_MARGIN;
  let target=a.cruise;
  if(ahead&&gap<warning)target=Math.min(target,Math.max(0,ahead.speed+Math.max(0,gap-minimum)*3.2));
  if(ahead&&gap<=minimum+.5)target=Math.min(target,ahead.speed);

  const station=nextStation(a),stationDistance=(station.x-a.x)*a.direction;
  const basePlatform=platformForLane(station,a.lane);
  const divergingRoute=a.plannedStation===station.id&&a.plannedPlatform!==undefined&&a.plannedPlatform!==basePlatform;
  // A diverging train visibly slows before the outer crossover. This is both more realistic and makes
  // the switch action readable in a 5× demo instead of looking like an instantaneous lane jump.
  if(divergingRoute&&stationDistance>0&&stationDistance<=DIVERGING_APPROACH_DISTANCE)target=Math.min(target,DIVERGING_APPROACH_SPEED);
  if(divergingRoute&&stationDistance>0&&stationDistance<=PLATFORM_THROAT_DISTANCE)target=Math.min(target,DIVERGING_SWITCH_SPEED);
  const ownPlatform=platformFor(a,station);
  const routeOwnerSafe=stationDistance>8&&stationDistance<=PLATFORM_THROAT_DISTANCE?routeOwners.get(`${station.id}:${ownPlatform}`)===a.id:true;
  const reservationSafe=stationDistance>8&&stationDistance<=PLATFORM_THROAT_DISTANCE?hasSafeReservation(reservations,a,station)&&routeOwnerSafe:true;
  const inBlock=s.blocked.includes(a.lane)&&((a.direction===1&&a.x>=900&&a.x<982)||(a.direction===-1&&a.x<=988&&a.x>906));
  if(inBlock||!reservationSafe){a.speed=0;a.status='Waiting';a.delay+=dt;return a;}

  a.speed=target;a.status=target>1?'Running':'Waiting';
  if(target<=1){a.delay+=dt;return a;}
  let movement=target/3600/.09*dt;
  if(ahead)movement=Math.min(movement,Math.max(0,gap-minimum));
  let nx=a.x+movement*a.direction;

  if(s.blocked.includes(a.lane)){
   if(a.direction===1&&a.x<900)nx=Math.min(nx,900);
   if(a.direction===-1&&a.x>988)nx=Math.max(nx,988);
  }
  if(stationDistance>8&&stationDistance<=PLATFORM_THROAT_DISTANCE&&!reservationSafe){
   const throat=station.x-a.direction*PLATFORM_THROAT_DISTANCE;nx=a.direction===1?Math.min(nx,throat):Math.max(nx,throat);
  }

  for(const st of stations){
   if(!a.visited.includes(st.id)&&(st.x-a.x)*a.direction>=0&&(st.x-nx)*a.direction<=0){
    const occupied=trains.some(o=>o.id!==a.id&&Math.abs(o.x-st.x)<28&&platformFor(o,st)===platformFor(a,st));
    if(occupied){const throat=st.x-a.direction*PLATFORM_THROAT_DISTANCE;nx=a.direction===1?Math.min(nx,throat):Math.max(nx,throat);a.speed=0;a.status='Waiting';a.delay+=dt;break;}
    nx=st.x;a.dwell=dwellSeconds(a);a.visited.push(st.id);a.status='Dwelling';a.speed=0;
    a.plannedStation=st.id;a.plannedLane=a.lane;a.plannedPlatform=a.plannedPlatform??platformForLane(st,a.lane);
    break;
   }
  }
  if(nx>1488||nx<12){
   const entry=a.direction===1?12:1488;
   const entryClear=!trains.some(o=>o.id!==a.id&&o.lane===a.lane&&o.direction===a.direction&&Math.abs(o.x-entry)<PLATFORM_BLOCK_LENGTH);
   if(!entryClear){
    nx=a.direction===1?1488:12;a.speed=0;a.status='Waiting';a.delay+=dt;
   }else{
    nx=entry;a.visited=[];a.cycle+=1;a.speed=a.cruise;a.status='Running';a.authority='approved';a.authorityReason='Recurring service loop restarted after the entry block cleared.';a.authorityDecisionId=undefined;a.plannedStation=undefined;a.plannedLane=undefined;a.plannedPlatform=undefined;a.routeSetAt=undefined;
   }
  }
  a.x=nx;return a;
 });
}


function enforceHardHeadway(trains:Train[],dt:number){
 for(const lane of Array.from({length:6},(_,i)=>i)){
  for(const direction of [1,-1] as const){
   const line=trains.filter(t=>t.lane===lane&&t.direction===direction).sort((a,b)=>direction===1?a.x-b.x:b.x-a.x);
   for(let i=line.length-2;i>=0;i--){
    const follower=line[i],leader=line[i+1];
    if(!sharesPhysicalPath(follower,leader))continue;
    const minimum=PLATFORM_BLOCK_LENGTH;
    const gap=Math.abs(leader.x-follower.x);
    if(gap>=minimum)continue;
    follower.x=leader.x-direction*minimum;
    follower.speed=Math.min(follower.speed,leader.speed);
    if(leader.speed<2){follower.speed=0;follower.status='Waiting';follower.delay+=dt;}
   }
  }
 }
 return trains;
}
function refreshReservations(reservations:PlatformReservation[],trains:Train[],time:number):PlatformReservation[]{
 const out:PlatformReservation[]=[];
 for(const r of reservations){
  const train=trains.find(t=>t.id===r.trainId);if(!train)continue;
  const station=stations.find(s=>s.id===r.station);if(!station)continue;
  if(Math.abs(train.x-station.x)<28&&(train.dwell>0||train.hold>0||train.status==='Held')){out.push({...r,lane:train.lane,platform:platformFor(train,station),state:'occupied',until:Math.max(r.until,time+Math.max(train.dwell,train.hold,5)+PLATFORM_CLEARANCE_SECONDS)});continue;}
  const ahead=(station.x-train.x)*train.direction;
  if(ahead<-35||r.until<time-5)continue;
  out.push({...r,state:'reserved'});
 }
 return out;
}

function updateConflicts(s:Simulation,trains:Train[],reservations:PlatformReservation[],time:number,events:DecisionEvent[]){
 let resolutions=s.resolutions;
 let conflicts=s.conflicts.map(c=>({...c}));
 const trainById=new Map(trains.map(t=>[t.id,t]));
 const newlyCleared:string[]=[];

 conflicts=conflicts.map(c=>{
  if(c.resolved||c.type!=='headway')return c;
  const [a,b]=c.trains.map(id=>trainById.get(id));
  const grace=c.severity==='high'?45:8;
  if(c.trains.length===1){
   if(time-c.created>=grace&&(!a||a.hold<=0)){resolutions++;newlyCleared.push(...c.trains);return {...c,resolved:true};}
   return c;
  }
  if(time-c.created>=grace&&(!a||!b||!sharesPhysicalPath(a,b)||Math.abs(a.x-b.x)>PLATFORM_BLOCK_LENGTH+20)){resolutions++;newlyCleared.push(...c.trains);return {...c,resolved:true};}
  return c;
 });
 if(newlyCleared.length){
  const cleared=new Set(newlyCleared);
  for(const t of trains)if(cleared.has(t.id)&&t.authority==='pending'){t.authority='approved';t.authorityReason='Conflict cleared before agent action; deterministic movement continues.';}
  events=appendEvent(events,time,'SYSTEM','Headway conflict cleared automatically after safe separation was restored.');
 }

 const activePair=(a:string,b:string)=>conflicts.some(c=>!c.resolved&&c.type==='headway'&&c.trains.includes(a)&&c.trains.includes(b));
 for(const lane of Array.from({length:6},(_,i)=>i)){
  for(const direction of [1,-1] as const){
   const line=trains.filter(t=>t.lane===lane&&t.direction===direction).sort((a,b)=>direction===1?a.x-b.x:b.x-a.x);
   for(let i=0;i<line.length-1;i++){
    const follower=line[i],leader=line[i+1];
    if(!sharesPhysicalPath(follower,leader))continue;
    const gap=Math.abs(leader.x-follower.x),minimum=safeGap(follower);
    if(gap>=minimum+AGENT_HEADWAY_MARGIN||activePair(follower.id,leader.id))continue;
    const high=gap<minimum+5;
    conflicts.push({id:`headway-${follower.id}-${leader.id}-${Math.floor(time)}`,type:'headway',title:`Headway · ${follower.id} / ${leader.id}`,detail:`Block separation is regulating the follower. Hard minimum ${PLATFORM_BLOCK_LENGTH} map-units (one platform length); speed control adds extra braking margin before this point.`,station:stations.reduce((a,b)=>Math.abs(a.x-follower.x)<Math.abs(b.x-follower.x)?a:b).id,trains:[follower.id,leader.id],severity:high?'high':'medium',created:time,lane,x:(follower.x+leader.x)/2,resolved:false});
    const needsAgent=high||(leader.hold>0&&!nearStationPlatform(leader));
    if(needsAgent){
     follower.authority='pending';follower.authorityReason='Operational headway exception queued for live agent review.';
     if(high){leader.authority='pending';leader.authorityReason='High-severity headway cluster queued for coordinated review.';}
     events=appendEvent(events,time,'SON',`${follower.id}: operational headway exception behind ${leader.id}; deterministic block protection remains active while agents review.`);
    }
   }
  }
 }

 // If every compatible platform is unavailable, create an exception instead of silently letting a train enter.
 for(const train of trains){
  if(train.dwell>0||train.hold>0)continue;
  const station=nextStation(train),distance=(station.x-train.x)*train.direction;
  if(distance<=8||distance>PLATFORM_THROAT_DISTANCE)continue;
  const hasReservation=reservations.some(r=>r.trainId===train.id&&r.station===station.id);
  if(hasReservation)continue;
  const existing=conflicts.some(c=>!c.resolved&&c.type==='platform'&&c.trains.includes(train.id)&&c.station===station.id);
  if(existing)continue;
  conflicts.push({id:`platform-${train.id}-${station.id}-${Math.floor(time)}`,type:'platform',title:`No free platform · ${train.id}`,detail:`No conflict-free compatible platform is currently available at ${station.name}. The train is protected outside the throat until a route opens.`,station:station.id,trains:[train.id],severity:'high',created:time,lane:train.lane,x:station.x-train.direction*PLATFORM_THROAT_DISTANCE,resolved:false});
  train.authority='pending';train.authorityReason='No compatible platform is currently free; live dispatch review requested.';
  events=appendEvent(events,time,'SON',`${train.id}: no free platform at ${station.short}; protected outside the station while alternatives are evaluated.`);
 }

 // Dynamic platform exceptions clear as soon as a reservation becomes available.
 conflicts=conflicts.map(c=>{
  if(c.resolved||c.type!=='platform'||!c.id.startsWith('platform-'))return c;
  const train=trainById.get(c.trains[0]);
  if(train&&reservations.some(r=>r.trainId===train.id&&r.station===c.station)){resolutions++;if(train.authority==='pending'){train.authority='approved';train.authorityReason='Alternative platform reserved; deterministic movement resumed.';}return {...c,resolved:true};}
  return c;
 });

 return {trains,conflicts:conflicts.slice(-70),events,resolutions};
}

export function tick(s:Simulation,dt:number):Simulation {
 const time=s.time+dt;
 let trains=s.trains.map(t=>({...t,visited:[...t.visited]}));
 let events=s.events,routeChanges=s.routeChanges;
 const reactive=applyReactiveReroutes(s,trains,time);trains=reactive.trains;events=reactive.events;routeChanges+=reactive.routeChanges;
 const planned=buildPlatformPlan(s,trains,time,events);trains=planned.trains;events=planned.events;routeChanges+=planned.routeChanges;
 trains=moveTrains(s,trains,planned.reservations,time,dt);
 trains=enforceHardHeadway(trains,dt);
 const reservations=refreshReservations(planned.reservations,trains,time);
 const conflictUpdate=updateConflicts(s,trains,reservations,time,events);trains=conflictUpdate.trains;events=conflictUpdate.events;
 return {...s,time,trains,platformReservations:reservations,routeChanges,events,conflicts:conflictUpdate.conflicts,resolutions:conflictUpdate.resolutions,totalHeld:s.totalHeld+trains.filter(t=>t.status==='Held'||t.status==='Waiting').length*dt};
}

export function applyAgentCycle(s:Simulation,response:AgentCycleResponse):Simulation{
 if(!response.ok)return {...s,events:logEvent(s,'SYSTEM',`Agent cycle failed: ${response.error??'invalid response'}. Deterministic movement remains active.`)};
 const final=new Map(response.finalDecisions.map(d=>[d.trainId,d]));
 const trains=s.trains.map(t=>{
  if(!response.requestedTrainIds.includes(t.id)||t.authority!=='pending')return {...t};
  const d=final.get(t.id);
  if(!d)return {...t,authority:'approved' as const,authorityReason:'Agent response omitted this service; deterministic controller retained movement.'};
  if(d.action==='PROCEED')return {...t,authority:'approved' as const,authorityReason:d.reason,authorityDecisionId:response.decisionId};
  const hold=Math.min(60,Math.max(8,d.holdSeconds??20));
  return {...t,authority:'denied' as const,authorityReason:d.reason,authorityDecisionId:response.decisionId,hold,speed:0,status:'Held' as const};
 });
 let events=s.events;
 for(const stage of response.stages){
  const level:DecisionEvent['level']=stage.level==='LOCAL'?'SON':stage.level==='REGIONAL'?'MOTHER':'GRANDMA';
  events=[...events,{id:`${s.time}-${events.length}-${level}`,time:s.time,level,text:`${stage.level} LLM · ${stage.summary}`}].slice(-200);
 }
 if(response.quantum){events=[...events,{id:`${s.time}-${events.length}-QAOA`,time:s.time,level:'GRANDMA' as const,text:`QAOA ${response.quantum.device??'simulator'}: ${response.quantum.qubits} qubits · ${response.quantum.evaluations} evaluations · ${response.quantum.runtime.toFixed(0)} ms · order ${response.quantum.quantum?.order.join(' → ')||'no feasible sample'}.`}].slice(-200);}
 return {...s,trains,events};
}

export function setAuthorityPending(s:Simulation,trainIds:string[],reason='Operational state changed; agent review requested.'):Simulation{
 const set=new Set(trainIds);return {...s,trains:s.trains.map(t=>set.has(t.id)?{...t,authority:'pending',authorityReason:reason,authorityDecisionId:undefined}:t)};
}

export function injectScenario(s:Simulation,sc:Scenario):Simulation {
 let next={...s,trains:s.trains.map(t=>({...t,visited:[...t.visited]})),blocked:[...s.blocked],platformReservations:[...s.platformReservations]};const train=next.trains.find(t=>t.id===sc.trainId)!;
 let title='',detail='';const affected=[train.id];let type:Conflict['type']='headway',x=train.x,lane=train.lane;
 if(sc.type==='delay'){train.hold+=sc.value*60;train.authority='pending';train.authorityReason='Injected stop queued for agent review; surrounding traffic may reroute.';train.speed=0;train.status='Held';title=`${train.id} held for ${sc.value} min`;detail='The selected train is stopped. Following services may use an available parallel route instead of waiting behind it.';type='headway';}
 if(sc.type==='block'){lane=sc.lane;if(!next.blocked.includes(lane))next.blocked.push(lane);title=`Running lane ${lane+1} blocked`;detail='The section is closed. Approaching services are pre-routed to compatible parallel lanes when capacity exists.';type='block';x=945;affected.splice(0,1,...next.trains.filter(t=>t.lane===lane).map(t=>t.id));for(const t of next.trains.filter(t=>t.lane===lane)){t.authority='pending';t.authorityReason='Blocked section queued for routing review; deterministic rerouting remains active.';}}
 if(sc.type==='platform'){next.closedPlatform=true;title='Düsseldorf platform 10 closed';detail='Platform 10 is unavailable. Approaching trains are reassigned before the station throat whenever another compatible platform is free.';type='platform';lane=2;x=750;affected.splice(0,1,...next.trains.filter(t=>t.direction===1).map(t=>t.id));for(const t of next.trains.filter(t=>t.direction===1)){t.authority='pending';t.authorityReason='Düsseldorf platform closure queued for dispatch review; alternative platform planning is active.';}}
 if(sc.type==='speed'){train.cruise=sc.value;train.authority='pending';train.authorityReason='Speed restriction queued for agent review; train continues at the new limit.';title=`${train.id} limited to ${sc.value} km/h`;detail='A temporary speed restriction applies while following trains regulate or reroute around the slower service.';type='speed';}
 const conflict:Conflict={id:`scenario-${Math.floor(s.time)}-${s.conflicts.length}`,type,title,detail,station:'dusseldorf',trains:affected,severity:sc.type==='block'||sc.type==='platform'?'high':'medium',created:s.time,resolved:false,lane,x};
 next.conflicts=[...s.conflicts,conflict];next.events=logEvent(next,'SON',`Scenario detected: ${title}. Deterministic routing reacted immediately; live agents are reviewing the exception.`);return next;
}

export function resolveConflict(s:Simulation,id:string):Simulation {
 const c=s.conflicts.find(c=>c.id===id);if(!c||c.resolved)return s;
 let next={...s,trains:s.trains.map(t=>({...t})),blocked:s.blocked.filter(l=>c.type!=='block'||l!==c.lane),closedPlatform:c.type==='platform'?false:s.closedPlatform,resolutions:s.resolutions+1,conflicts:s.conflicts.map(item=>item.id===id?{...item,resolved:true}:item)};
 const affected=new Set(c.trains);
 next.trains=next.trains.map(t=>affected.has(t.id)?{...t,authority:'pending',authorityReason:'Restriction changed; live agents are reviewing the new state.',authorityDecisionId:undefined}:t);
 next.events=logEvent(next,'SYSTEM','Restriction changed. Continuous deterministic routing remains active while agents review the new state.');return next;
}

export function applyOrder(s:Simulation,order:string[]):Simulation {
 const spacing=20;
 let next={...s,trains:s.trains.map(t=>{const slot=order.indexOf(t.id);return slot<0?t:{...t,hold:slot*spacing,speed:slot?0:t.speed,status:slot?'Held' as const:t.status,authority:'approved' as const,authorityReason:`QAOA release order applied · slot ${slot+1}.`};})};
 next.events=logEvent(next,'GRANDMA',`QAOA candidate schedule applied: ${order.join(' → ')} · ${spacing}s release spacing. Deterministic platform/headway protection remains in force.`);return next;
}
