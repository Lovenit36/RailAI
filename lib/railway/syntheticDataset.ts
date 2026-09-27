import type {StationId,Train} from './types';

interface ServicePattern {
 line:string; type:Train['type']; direction:1|-1; lane:number; headwayMinutes:number; cruise:number; origin:StationId; destination:StationId; ids:string[]; phaseMinutes:number[];
}

// Self-generated demo timetable. It intentionally models cadence, not DB production data.
// Eight service instances per running lane create a 48-train stress timetable while preserving repeatable service cadence.
const patterns:ServicePattern[]=[
 {line:'RE 1',type:'RE',direction:1,lane:0,headwayMinutes:30,cruise:140,origin:'koln',destination:'dortmund',ids:['RE 1-01','RE 1-02','RE 1-03','RE 1-04','RE 1-05','RE 1-06','RE 1-07','RE 1-08'],phaseMinutes:[0,30,60,90,120,150,180,210]},
 {line:'RE 1',type:'RE',direction:-1,lane:1,headwayMinutes:30,cruise:140,origin:'dortmund',destination:'koln',ids:['RE 1-51','RE 1-52','RE 1-53','RE 1-54','RE 1-55','RE 1-56','RE 1-57','RE 1-58'],phaseMinutes:[15,45,75,105,135,165,195,225]},
 {line:'ICE 6',type:'ICE',direction:1,lane:2,headwayMinutes:30,cruise:190,origin:'koln',destination:'dortmund',ids:['ICE 612','ICE 614','ICE 616','ICE 618','ICE 620','ICE 622','ICE 624','ICE 626'],phaseMinutes:[5,35,65,95,125,155,185,215]},
 {line:'ICE 7',type:'ICE',direction:-1,lane:3,headwayMinutes:30,cruise:190,origin:'dortmund',destination:'koln',ids:['ICE 729','ICE 731','ICE 733','ICE 735','ICE 737','ICE 739','ICE 741','ICE 743'],phaseMinutes:[20,50,80,110,140,170,200,230]},
 {line:'S 11',type:'S',direction:1,lane:4,headwayMinutes:20,cruise:100,origin:'koln',destination:'dortmund',ids:['S 11-01','S 11-02','S 11-03','S 11-04','S 11-05','S 11-06','S 11-07','S 11-08'],phaseMinutes:[0,20,40,60,80,100,120,140]},
 {line:'RB 40',type:'RB',direction:-1,lane:5,headwayMinutes:30,cruise:130,origin:'dortmund',destination:'koln',ids:['RB 40-01','RB 40-02','RB 40-03','RB 40-04','RB 40-05','RB 40-06','RB 40-07','RB 40-08'],phaseMinutes:[10,40,70,100,130,160,190,220]},
];

export const SYNTHETIC_SERVICE_COUNT=patterns.reduce((n,p)=>n+p.ids.length,0);

export function generateSyntheticTrains():Train[]{
 const minX=80,maxX=1420,span=maxX-minX;
 const trains:Train[]=[];
 for(const pattern of patterns){
  pattern.ids.forEach((id,index)=>{
   const fraction=index/pattern.ids.length;
   const x=pattern.direction===1?minX+fraction*span:maxX-fraction*span;
   trains.push({
    id,type:pattern.type,lane:pattern.lane,x,direction:pattern.direction,cruise:pattern.cruise,speed:0,delay:(index===0&&pattern.type==='ICE')?120:0,hold:0,dwell:0,visited:[],source:'SIMULATED',status:'Running',origin:pattern.origin,destination:pattern.destination,
    serviceLine:pattern.line,headwayMinutes:pattern.headwayMinutes,cycle:0,authority:'approved',authorityReason:'Continuous deterministic movement controller active.'
   });
  });
 }
 // Deliberately create one controlled Düsseldorf approach conflict for the agent/QUBO/QAOA path.
 // With eight services on this lane, use the middle pair so neighbouring trains still keep safe spacing.
 const ice618=trains.find(t=>t.id==='ICE 618');const ice620=trains.find(t=>t.id==='ICE 620');
 if(ice618&&ice620){ice620.x=ice618.x+154;}
 return trains;
}
