import type {Station, Train} from './types';
export const WIDTH = 1500;
export const HEIGHT = 510;
export const stations: Station[] = [
 {id:'koln',name:'Köln Hbf',short:'Köln',code:'KK',x:210,tracks:[1,2,3,4,5,6,7,8,9,10,11],sourceUrl:'https://www.bahnhof.de/downloads/station-plans/3320.pdf'},
 {id:'dusseldorf',name:'Düsseldorf Hbf',short:'Düsseldorf',code:'KD',x:750,tracks:[4,5,6,7,8,9,10,11,12,13,14,15,16,18,19,20],sourceUrl:'https://www.bahnhof.de/downloads/station-plans/1401.pdf'},
 {id:'dortmund',name:'Dortmund Hbf',short:'Dortmund',code:'EDO',x:1280,tracks:[2,3,4,5,6,7,8,10,11,16,18,20,21,23,26,31],sourceUrl:'https://www.bahnhof.de/downloads/station-plans/1289.pdf'}
];
export const laneColors=['#629cfa','#629cfa','#56cdb0','#56cdb0','#a798e9','#a798e9'];
export const laneY=(lane:number)=>226+lane*23;
export const trackY=(s:Station,index:number)=>270-(s.tracks.length-1)*8.5+index*17;
export const laneTrack=(s:Station,lane:number)=>s.id==='koln'?[1,3,5,6,9,10][lane]:s.id==='dusseldorf'?[1,3,6,8,12,14][lane]:[6,7,8,9,12,14][lane];
export const directionLanes=(direction:1|-1)=>direction===1?[0,2,4]:[1,3,5];
export const platformForLane=(s:Station,lane:number)=>s.tracks[laneTrack(s,lane)];
export const platformIndex=(s:Station,platform:number)=>s.tracks.indexOf(platform);

/**
 * Schematic switch budget for the demo network.
 * A train can reach more neighbouring platform tracks while it is still far from the station.
 * The final route must be selected before the train reaches the visible outer crossover (~165 map units from the station).
 */
export const platformShiftBudget=(distance:number)=>distance>=310?3:distance>=245?2:distance>=190?1:0;
export const reachablePlatforms=(s:Station,lane:number,distance:number)=>{
 const base=laneTrack(s,lane),budget=platformShiftBudget(distance);
 return s.tracks
  .map((platform,index)=>({platform,index,shift:Math.abs(index-base)}))
  .filter(x=>x.shift<=budget)
  .sort((a,b)=>a.shift-b.shift||Math.abs(a.platform-platformForLane(s,lane))-Math.abs(b.platform-platformForLane(s,lane)));
};

export const pointsForLane=(lane:number):[number,number][]=>{
 const pts:[number,number][]=[[15,laneY(lane)]];
 for(const s of stations){const y=trackY(s,laneTrack(s,lane));pts.push([s.x-165,laneY(lane)],[s.x-95,y],[s.x+65,y],[s.x+155,laneY(lane)]);}
 pts.push([1485,laneY(lane)]);return pts;
};
export const polyline=(p:[number,number][])=>p.map(([x,y],i)=>`${i?'L':'M'}${x},${y}`).join(' ');
export const yAt=(x:number,lane:number)=>{const p=pointsForLane(lane);for(let i=1;i<p.length;i++){if(x<=p[i][0]){const a=p[i-1],b=p[i];return a[1]+(b[1]-a[1])*(x-a[0])/(b[0]-a[0]);}}return p[p.length-1][1];};
export const nextStation=(t:Train)=>t.direction===1?(stations.find(s=>s.x>t.x+8)??stations[0]):([...stations].reverse().find(s=>s.x<t.x-8)??stations[2]);
export const platformFor=(t:Train,s:Station)=>t.plannedStation===s.id&&t.plannedPlatform? t.plannedPlatform : platformForLane(s,t.lane);

// Render a platform reassignment as a real diverging path through the station throat
// without pretending the train changed its corridor running line kilometres beforehand.
export const trainYAt=(t:Train)=>{
 const station=t.plannedStation?stations.find(s=>s.id===t.plannedStation):undefined;
 if(!station||!t.plannedPlatform)return yAt(t.x,t.lane);
 const index=platformIndex(station,t.plannedPlatform);
 if(index<0)return yAt(t.x,t.lane);
 const platformY=trackY(station,index),baseY=laneY(t.lane);
 const leftOuter=station.x-165,leftInner=station.x-95,rightInner=station.x+65,rightOuter=station.x+155;
 if(t.x<leftOuter||t.x>rightOuter)return yAt(t.x,t.lane);
 if(t.x<=leftInner){const f=(t.x-leftOuter)/(leftInner-leftOuter);return baseY+(platformY-baseY)*Math.max(0,Math.min(1,f));}
 if(t.x<=rightInner)return platformY;
 const f=(t.x-rightInner)/(rightOuter-rightInner);return platformY+(baseY-platformY)*Math.max(0,Math.min(1,f));
};


export const stationRoutePath=(s:Station,lane:number,platform:number)=>{
 const index=platformIndex(s,platform);
 if(index<0)return polyline(pointsForLane(lane));
 const y=trackY(s,index),base=laneY(lane);
 return `M${s.x-165},${base} L${s.x-95},${y} H${s.x+65} L${s.x+155},${base}`;
};

export const routeSwitchState=(t:Train,s:Station)=>{
 const base=platformForLane(s,t.lane);
 const selected=platformFor(t,s);
 return {basePlatform:base,selectedPlatform:selected,diverging:selected!==base};
};

export const clock=(seconds:number)=>{let s=Math.max(0,Math.floor(seconds));return `${String(Math.floor(s/3600)%24).padStart(2,'0')}:${String(Math.floor(s/60)%60).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;};
export const BASE_TIME=14*3600+27*60;
export const kmToNext=(t:Train)=>Math.abs(nextStation(t).x-t.x)*.09;
export const etaMinutes=(t:Train)=>Math.ceil(kmToNext(t)/Math.max(30,t.cruise)*60+t.hold/60+t.dwell/60);
