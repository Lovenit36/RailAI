import {NextResponse} from 'next/server';
import {optimizeRemote} from '@/lib/railway/quantumRemote';
import type {Train} from '@/lib/railway/types';

export const runtime='nodejs';

export async function POST(request:Request){
 try{
  const body=await request.json() as {trains:Train[];shots?:number;seed?:number;requestedIds?:string[]};
  if(!Array.isArray(body.trains)||body.trains.length<3)return NextResponse.json({error:'At least three trains are required.'},{status:400});
  const shots=Math.min(16384,Math.max(128,Number(body.shots||2048)));
  const result=await optimizeRemote(body.trains,shots,Number(body.seed||42),body.requestedIds);
  return NextResponse.json(result);
 }catch(error:any){
  const message=error?.name==='AbortError'?'RunPod quantum request timed out.':String(error?.message||error);
  return NextResponse.json({error:message},{status:503});
 }
}
