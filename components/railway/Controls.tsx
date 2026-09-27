'use client';
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from '@/components/ui/select';
import {Tabs,TabsList,TabsTrigger} from '@/components/ui/tabs';
export function Choice({value,onChange,options,label,className=''}:{value:string;onChange:(s:string)=>void;options:{value:string;label:string}[];label:string;className?:string}){return <Select value={value} onValueChange={onChange}><SelectTrigger aria-label={label} className={`choice ${className}`}><SelectValue/></SelectTrigger><SelectContent position="popper">{options.map(o=><SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent></Select>;}
export function Segments({value,onChange,options,label}:{value:string;onChange:(s:string)=>void;options:{value:string;label:React.ReactNode}[];label:string}){return <Tabs value={value} onValueChange={onChange} className="segments"><TabsList aria-label={label}>{options.map(o=><TabsTrigger value={o.value} key={o.value}>{o.label}</TabsTrigger>)}</TabsList></Tabs>;}
export function SourceBadge({source='SIMULATED'}:{source?:string}){return <span className={`source-badge source-${source.toLowerCase()}`}>{source}</span>;}
