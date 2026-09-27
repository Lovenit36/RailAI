import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundle=async path=>{const {outputFiles}=await build({entryPoints:[path],bundle:true,write:false,format:'esm',platform:'node'});return import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64'));};
const sim=await bundle('lib/railway/simulation.ts'),q=await bundle('lib/railway/quantum.ts'),protocol=await bundle('lib/railway/agentProtocol.ts'),network=await bundle('lib/railway/network.ts');
const initial=sim.initialSimulation();
assert.equal(initial.trains.length,48);
assert.equal(initial.trains.filter(t=>t.authority==='pending').length,2);
assert(initial.platformReservations.length===0);

// Normal movement is continuous; an LLM review is not a per-segment movement gate.
const moving=sim.tick(initial,10);
assert(moving.trains.some((t,i)=>Math.abs(t.x-initial.trains[i].x)>.01),'corridor should move before an LLM response');
const ice618Before=initial.trains.find(t=>t.id==='ICE 618'),ice618After=moving.trains.find(t=>t.id==='ICE 618');
assert(ice618Before&&ice618After&&ice618After.x>=ice618Before.x,'pending conflict train should remain under deterministic movement control');

// Station arrival creates dwell but does not consume movement authority.
let checkpoint={...initial,trains:initial.trains.map((t,i)=>i===0?{...t,x:205,direction:1,authority:'approved',visited:[],hold:0,dwell:0,lane:0}:t)};
checkpoint=sim.tick(checkpoint,20);
assert.equal(checkpoint.trains[0].x,210);
assert.equal(checkpoint.trains[0].authority,'approved');
assert.equal(checkpoint.trains[0].status,'Dwelling');

// Platform closure triggers advance rerouting instead of freezing the train on the closed platform lane.
let platformCase={...sim.initialSimulation(),trains:sim.initialSimulation().trains.map(t=>t.id==='ICE 612'?{...t,x:610,lane:2,direction:1,hold:0,dwell:0,authority:'approved'}:{...t})};
platformCase=sim.injectScenario(platformCase,{type:'platform',trainId:'ICE 612',value:0,lane:2});
platformCase=sim.tick(platformCase,1);
const rerouted=platformCase.trains.find(t=>t.id==='ICE 612');
assert(rerouted);
assert.notEqual(rerouted.plannedPlatform,10,'closed Düsseldorf platform 10 must not be reserved');
assert.equal(rerouted.lane,2,'platform reassignment must not fake a corridor running-lane jump');
assert(rerouted.plannedPlatform>=7&&rerouted.plannedPlatform<=13,'alternative platform should stay within the reachable switch neighbourhood');
assert(platformCase.platformReservations.some(r=>r.trainId==='ICE 612'&&r.station==='dusseldorf'&&r.platform!==10));

// A train held in a station should trigger a nearby platform reassignment, not a fake lane jump.
let stationHold=sim.initialSimulation();
stationHold={...stationHold,trains:stationHold.trains.map(t=>t.id==='ICE 733'?{...t,x:750,lane:3,direction:-1,hold:400,dwell:0,speed:0,status:'Held',plannedStation:'dusseldorf',plannedPlatform:12}:t.id==='ICE 731'?{...t,x:930,lane:3,direction:-1,hold:0,speed:190,status:'Running',plannedStation:undefined,plannedPlatform:undefined}:t)};
stationHold=sim.tick(stationHold,1);
const follower=stationHold.trains.find(t=>t.id==='ICE 731');
assert(follower&&follower.lane===3,'station platform reassignment must keep the corridor running lane');
assert(follower.plannedPlatform!==12,'following train must avoid the occupied platform');
assert(Math.abs(follower.plannedPlatform-12)<=3,'following train should use a nearby reachable platform');

// The map route renderer must expose the actual diverging platform path, not only a static switch dot.
const dus=network.stations.find(s=>s.id==='dusseldorf');
const basePlatform=network.platformForLane(dus,3);
const altPlatform=follower.plannedPlatform;
assert.notEqual(network.stationRoutePath(dus,3,basePlatform),network.stationRoutePath(dus,3,altPlatform),'rerouted platform must render a distinct switch path');

// Predictive ETA includes headway regulation when a stopped leader occupies the same physical path.
let predictionCase=sim.initialSimulation();
predictionCase={...predictionCase,trains:predictionCase.trains.map(t=>t.id==='RE 1-01'?{...t,x:500,lane:0,direction:1,speed:140,cruise:140,hold:0,dwell:0,plannedStation:undefined,plannedPlatform:undefined}:t.id==='ICE 612'?{...t,x:620,lane:0,direction:1,speed:0,cruise:190,hold:120,dwell:0,plannedStation:undefined,plannedPlatform:undefined}:t)};
const predicted=sim.predictArrival(predictionCase,predictionCase.trains.find(t=>t.id==='RE 1-01'));
assert(predicted.headwayDelaySeconds>0,'prediction must include a future headway delay behind a stopped leader');

// An injected single-train hold conflict must stay active until the hold actually clears.
let injected=sim.injectScenario(sim.initialSimulation(),{type:'delay',trainId:'RE 1-01',value:1,lane:0});
injected=sim.tick(injected,10);
assert(injected.conflicts.some(c=>!c.resolved&&c.title.includes('RE 1-01 held')),'hold conflict must not disappear while the train is still held');

// HOLD advice is bounded and movement resumes deterministically after it expires.
const holdCycle={ok:true,decisionId:'test-hold',requestedTrainIds:['ICE 612'],stages:[],finalDecisions:[{trainId:'ICE 612',action:'HOLD',reason:'test hold',holdSeconds:900}],quantum:null};
let held=sim.applyAgentCycle(initial,holdCycle);
const heldTrain=held.trains.find(t=>t.id==='ICE 612');
assert(heldTrain&&heldTrain.hold<=60&&heldTrain.authority==='denied');
held=sim.tick(held,61);
const resumed=held.trains.find(t=>t.id==='ICE 612');
assert(resumed&&resumed.hold===0&&resumed.authority==='approved');

// Default 48-train corridor stress: run the real V4 timetable for a full simulated hour.
let stress=sim.initialSimulation();
stress={...stress,trains:stress.trains.map(t=>({...t,hold:0,dwell:0,authority:'approved',authorityReason:'Stress test deterministic controller.',authorityDecisionId:undefined})),conflicts:[],events:[],platformReservations:[],blocked:[],closedPlatform:false};
for(let i=0;i<3600;i++)stress=sim.tick(stress,1);
for(const station of ['koln','dusseldorf','dortmund']){
 const occupied=stress.platformReservations.filter(r=>r.station===station&&r.state==='occupied').map(r=>r.platform);
 assert.equal(new Set(occupied).size,occupied.length,`${station} must never double-occupy a platform`);
}
for(const lane of Array.from({length:6},(_,i)=>i)){
 const line=stress.trains.filter(t=>t.lane===lane).sort((a,b)=>a.direction===1?a.x-b.x:b.x-a.x);
 for(let i=0;i<line.length-1;i++){
  const a=line[i],b=line[i+1],gap=Math.abs(a.x-b.x);
  const split=a.plannedStation===b.plannedStation&&a.plannedPlatform&&b.plannedPlatform&&a.plannedPlatform!==b.plannedPlatform;
  if(!split)assert(gap>=149,`stress headway ${a.id}/${b.id} fell below one platform-length block`);
 }
}

// Protocol parsing still rejects invented train IDs and unknown actions.
const ids=initial.trains.map(t=>t.id);
const normalized=protocol.normalizeStage('LOCAL',{summary:'x',decisions:[{trainId:ids[0],action:'PROCEED',reason:'ok'},{trainId:'FAKE',action:'PROCEED',reason:'bad'},{trainId:ids[1],action:'FLY',reason:'bad'}]},[ids[0],ids[1]],'test',12);
assert.equal(normalized.decisions.length,1);assert.equal(normalized.ok,false);

// QAOA remains a 9-qubit p=1 statevector model, now using a 64-point coarse/refine search.
const problem=q.makeProblem(initial.trains,ids.slice(0,6));const states=Array.from({length:512},(_,i)=>problem.evaluate(i));assert.equal(states.filter(x=>x.feasible).length,6);
for(const [gamma,beta] of [[0,0],[1.2,.6],[4.2,2.1]]){const probs=q.qaoaProbabilities(states.map(x=>x.energy),gamma,beta);assert(Math.abs(probs.reduce((sum,p)=>sum+p,0)-1)<1e-10);assert(probs.every(p=>p>=0));}
const result=q.optimize(initial.trains,512,42,ids.slice(0,6)),again=q.optimize(initial.trains,512,42,ids.slice(0,6));
assert.equal(result.qubits,9);assert.equal(result.evaluations,64);assert.equal(result.distribution.reduce((sum,x)=>sum+x.count,0),512);assert.deepEqual(result.distribution,again.distribution);assert(result.classical.feasible);assert(!result.quantum||result.quantum.energy>=result.classical.energy-1e-9);

console.log(JSON.stringify({checks:'passed',services:48,stressServices:48,stressSeconds:3600,continuousMovement:true,topologyAwarePlatforming:true,platformLengthHeadway:true,boundedAgentHolds:true,qubits:result.qubits,qaoaEvaluations:result.evaluations,deterministicSampling:true}));
