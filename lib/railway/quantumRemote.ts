import {makeProblem} from './quantum';
import type {QuantumResult,Train} from './types';

const QUANTUM_URL=process.env.QUANTUM_API_URL;

export async function optimizeRemote(trains:Train[],shots=512,seed=42,requestedIds?:string[]):Promise<QuantumResult>{
 if(!QUANTUM_URL)throw new Error('QUANTUM_API_URL is not configured.');
 const problem=makeProblem(trains,requestedIds);
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),30000);
 const started=performance.now();
 console.info(`[RailAI] QAOA -> RunPod · ${problem.labels.join(', ')} · ${shots} shots`);
 try{
  const response=await fetch(`${QUANTUM_URL.replace(/\/$/,'')}/solve`,{
   method:'POST',
   headers:{'content-type':'application/json'},
   body:JSON.stringify({labels:problem.labels,costs:problem.costs,penalty:problem.penalty,shots,seed}),
   signal:controller.signal,
   cache:'no-store'
  });
  if(!response.ok)throw new Error(`Quantum HTTP ${response.status}: ${(await response.text()).slice(0,240)}`);
  const result=await response.json() as QuantumResult;
  if(result?.qubits!==9||!result?.classical||!Array.isArray(result?.labels))throw new Error('Quantum service returned an invalid result.');
  console.info(`[RailAI] QAOA <- RunPod · ${result.evaluations} evals · ${Math.round(result.runtime)} ms solver · ${Math.round(performance.now()-started)} ms round-trip${result.cacheHit?' · cache hit':''}`);
  return result;
 }finally{clearTimeout(timer);}
}
