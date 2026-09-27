export type Source = 'SIMULATED' | 'REFERENCE' | 'INFERRED';
export type StationId = 'koln' | 'dusseldorf' | 'dortmund';
export type AgentLevel = 'LOCAL' | 'REGIONAL' | 'SUPERVISOR';
export type MovementAuthority = 'pending' | 'approved' | 'denied';
export type AgentAction = 'PROCEED' | 'HOLD' | 'ESCALATE';

export interface Station { id: StationId; name: string; short: string; code: string; x: number; tracks: number[]; sourceUrl: string; }
export interface Train {
 id: string; type: 'ICE' | 'RE' | 'RB' | 'S'; lane: number; x: number; direction: 1 | -1; cruise: number; speed: number; delay: number; hold: number; dwell: number; visited: string[]; source: Source; status: 'Running' | 'Dwelling' | 'Held' | 'Waiting'; origin: StationId; destination: StationId;
 serviceLine: string; headwayMinutes: number; cycle: number; authority: MovementAuthority; authorityReason: string; authorityDecisionId?: string;
 plannedStation?: StationId; plannedPlatform?: number; plannedLane?: number; lastRerouteAt?: number; lastRerouteReason?: string; routeSetAt?: number;
}
export type ConflictType = 'headway' | 'platform' | 'block' | 'speed';
export interface Conflict { id: string; type: ConflictType; title: string; detail: string; station: StationId; trains: string[]; severity: 'high' | 'medium'; created: number; resolved: boolean; lane: number; x: number; }
export interface DecisionEvent { id: string; time: number; level: 'SYSTEM' | 'SON' | 'MOTHER' | 'GRANDMA'; text: string; }
export interface Scenario { type: 'delay' | 'block' | 'platform' | 'speed'; trainId: string; value: number; lane: number; }
export interface PlatformReservation { station: StationId; platform: number; lane: number; trainId: string; from: number; until: number; state: 'reserved' | 'occupied'; }
export interface Simulation { time: number; trains: Train[]; conflicts: Conflict[]; events: DecisionEvent[]; blocked: number[]; closedPlatform: boolean; platformReservations: PlatformReservation[]; routeChanges: number; resolutions: number; totalHeld: number; }
export interface Snapshot { time: number; state: Simulation; }
export interface ArrivalPrediction { station: StationId; etaSeconds: number; travelSeconds: number; headwayDelaySeconds: number; platformDelaySeconds: number; confidence: 'HIGH' | 'MEDIUM' | 'LOW'; reasons: string[]; }
export interface QuboResult { bits: string; energy: number; feasible: boolean; order: string[]; delay: number; }
export interface QuantumResult {
 classical: QuboResult; quantum: QuboResult | null; distribution: {bits:string; probability:number; count:number; feasible:boolean; energy:number}[]; expectedEnergy: number; feasibility: number; shots: number; gamma: number; beta: number; qubits: number; evaluations: number; runtime: number; costs: number[][]; penalty: number; labels: string[]; seed: number;
 device?: string; solver?: string; cacheHit?: boolean; compileMs?: number; searchMs?: number; sampleMs?: number;
}

export interface AgentDecision {
 trainId: string;
 action: AgentAction;
 reason: string;
 holdSeconds?: number;
}
export interface AgentStageResult {
 level: AgentLevel;
 ok: boolean;
 model?: string;
 latencyMs?: number;
 summary: string;
 decisions: AgentDecision[];
}
export interface AgentCycleResponse {
 ok: boolean;
 decisionId: string;
 requestedTrainIds: string[];
 stages: AgentStageResult[];
 finalDecisions: AgentDecision[];
 quantum: QuantumResult | null;
 error?: string;
}
