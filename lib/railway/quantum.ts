import type {QuantumResult, QuboResult, Train} from './types';

const priority=(t:Train)=>t.type==='ICE'?2:t.type==='RE'?1.5:t.type==='RB'?1.2:1;

export function selectQuantumCandidates(trains:Train[],requestedIds?:string[]){
 const pool=(requestedIds?.length?trains.filter(t=>requestedIds.includes(t.id)):trains).slice();
 pool.sort((a,b)=>{
  const auth=(x:Train)=>x.authority==='approved'?0:1;
  return (auth(b)-auth(a)) || (b.delay-a.delay) || (priority(b)-priority(a)) || a.id.localeCompare(b.id);
 });
 const chosen=pool.slice(0,3);
 if(chosen.length<3)throw new Error('QAOA requires at least three candidate trains.');
 return chosen;
}

// Three trains × three release slots, one-hot assignment: nine binary variables.
// The candidate set is chosen from the live conflict/pending train set instead of hard-coded IDs.
export function makeProblem(trains:Train[],requestedIds?:string[]) {
 const chosen=selectQuantumCandidates(trains,requestedIds);
 const costs=chosen.map(t=>[0,1,2].map(slot=>slot*1.5*priority(t)*(1+t.delay/600)));
 const penalty=100;
 const evaluate=(state:number):QuboResult=>{
  let energy=0,delay=0;const row=[0,0,0],col=[0,0,0],order=['','',''];
  for(let i=0;i<3;i++)for(let j=0;j<3;j++)if(state&(1<<(i*3+j))){energy+=costs[i][j];delay+=costs[i][j];row[i]++;col[j]++;order[j]=chosen[i].id;}
  for(let i=0;i<3;i++)energy+=penalty*((row[i]-1)**2+(col[i]-1)**2);
  return {bits:state.toString(2).padStart(9,'0'),energy,feasible:row.every(x=>x===1)&&col.every(x=>x===1),order,delay};
 };
 return {costs,penalty,labels:chosen.map(t=>t.id),evaluate};
}
export function qaoaProbabilities(energies:number[],gamma:number,beta:number):number[]{
 const n=energies.length,qubits=Math.log2(n),real=new Float64Array(n),imag=new Float64Array(n),amp=1/Math.sqrt(n);
 for(let z=0;z<n;z++){const phase=-gamma*energies[z]/100;real[z]=amp*Math.cos(phase);imag[z]=amp*Math.sin(phase);}
 const c=Math.cos(beta),s=Math.sin(beta);
 for(let q=0;q<qubits;q++)for(let a=0;a<n;a++)if(!(a&(1<<q))){const b=a|(1<<q),ar=real[a],ai=imag[a],br=real[b],bi=imag[b];real[a]=c*ar+s*bi;imag[a]=c*ai-s*br;real[b]=c*br+s*ai;imag[b]=c*bi-s*ar;}
 return Array.from(real,(r,i)=>r*r+imag[i]*imag[i]);
}
export function optimize(trains:Train[],shots=2048,seed=42,requestedIds?:string[]):QuantumResult {
 const start=performance.now(),problem=makeProblem(trains,requestedIds),states=Array.from({length:512},(_,i)=>problem.evaluate(i)),energies=states.map(s=>s.energy);
 const classical=states.filter(s=>s.feasible).sort((a,b)=>a.energy-b.energy)[0];
 let best=Infinity,gamma=0,beta=0,probabilities:number[]=[],evaluations=0;
 const evaluate=(gg:number,bb:number)=>{const p=qaoaProbabilities(energies,gg,bb),energy=p.reduce((sum,v,i)=>sum+v*energies[i],0);evaluations++;if(energy<best){best=energy;gamma=gg;beta=bb;probabilities=p;}};
 // Same fast search shape as the RunPod Qiskit service: 48 coarse + 16 local-refinement points.
 for(let g=0;g<8;g++)for(let b=0;b<6;b++)evaluate((g+.5)*Math.PI*2/8,(b+.5)*Math.PI/6);
 const coarseGamma=gamma,coarseBeta=beta,gStep=Math.PI*2/8,bStep=Math.PI/6;
 for(const go of [-.375,-.125,.125,.375])for(const bo of [-.375,-.125,.125,.375])evaluate((coarseGamma+go*gStep+Math.PI*2)%(Math.PI*2),Math.min(Math.PI-1e-6,Math.max(1e-6,coarseBeta+bo*bStep)));
 let rng=seed>>>0;const random=()=>{rng=(Math.imul(1664525,rng)+1013904223)>>>0;return rng/4294967296;};
 const counts=Array(512).fill(0),cdf:number[]=[];probabilities.reduce((sum,p,i)=>{cdf[i]=sum+p;return sum+p;},0);
 for(let s=0;s<shots;s++){const value=random();let lo=0,hi=511;while(lo<hi){const mid=(lo+hi)>>1;if(cdf[mid]<value)lo=mid+1;else hi=mid;}counts[lo]++;}
 const sampled=states.filter((s,i)=>s.feasible&&counts[i]>0).sort((a,b)=>a.energy-b.energy);
 return {classical,quantum:sampled[0]??null,distribution:states.map((s,i)=>({bits:s.bits,energy:s.energy,feasible:s.feasible,probability:probabilities[i],count:counts[i]})).filter(s=>s.count>0).sort((a,b)=>b.count-a.count),expectedEnergy:best,feasibility:states.reduce((sum,s,i)=>sum+(s.feasible?counts[i]:0),0)/shots,shots,gamma,beta,qubits:9,evaluations,runtime:performance.now()-start,costs:problem.costs,penalty:problem.penalty,labels:problem.labels,seed,device:'LOCAL',solver:'QAOA-p1-fast-grid'};
}
