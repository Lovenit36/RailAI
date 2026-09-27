# RailAI — Rhine–Ruhr agent + quantum operations laboratory

A research prototype for the Köln–Düsseldorf–Dortmund corridor. The operational data is synthetic. The architecture is now wired as:

**Recurring synthetic timetable → movement-authority gate → Local LLM Agent → Regional LLM Agent → QAOA escalation when needed → Network Supervisor LLM → deterministic safety gate → train movement.**

## What is implemented

- 24 active synthetic services across six corridor lanes. RE 1, ICE, S-Bahn, and RB patterns recur with 20/30-minute cadences and loop through the corridor.
- Source dataset: `data/synthetic_corridor_schedule.csv`.
- Every train starts **locked**. A train cannot move without a valid movement authority.
- Arrival at a station or corridor boundary consumes the authority; the next segment requires a fresh agent cycle.
- Scenario changes such as block, platform closure, delay, and speed restriction revoke affected authorities.
- Three-stage live LLM chain: **Local Agent → Regional Agent → Network Supervisor**.
- Strict JSON validation: every stage must return a valid decision for every requested train. Missing/invalid responses fail closed.
- Deterministic safety checks override LLM output for blocked lanes, closed platforms, and unsafe close-following situations.
- Severe conflicts or an agent escalation automatically run the server-side 9-qubit, depth-1 QAOA statevector simulator before the supervisor decides.
- The Dispatch Lab still provides an interactive exact-classical-vs-QAOA comparison using the same QUBO logic.
- Session replay, analytics, scenarios, train/station/switch inspectors, and the existing schematic UI remain available.

## RunPod LLM configuration

Copy `.env.example` to `.env.local` and set:

```bash
RUNPOD_LLM_URL=https://<your-openai-compatible-endpoint>/v1/chat/completions
RUNPOD_MODEL=<model-name-served-by-vllm>
RUNPOD_API_KEY=<optional-bearer-token>
```

`RUNPOD_LLM_URL` is deliberately the **full chat-completions URL**, so the project works with a vLLM Pod proxy or another OpenAI-compatible RunPod deployment without hard-coding one RunPod deployment style.

If the endpoint is missing, times out, returns invalid JSON, omits a train, or any stage fails, the affected trains remain stopped. The app never falls back to a fake rule-based approval.

## Run

```bash
npm run dev
```

Validation used during this update:

```bash
npx tsc --noEmit
```

The updated model checks cover: 24 services, no-authority/no-movement, station re-authorization, disruption authority revocation, strict agent response validation, and deterministic 9-qubit QAOA sampling.

## Important boundaries

This is a railway-dispatch research simulator, not an interlocking or production control system. Station names/platform inventories are reference information; timetable, coordinates, routes, signals, conflicts, authorities, and decisions are synthetic. The QAOA component is a genuine statevector simulation, **not** a hardware QPU run. The LLM chain becomes live only when your RunPod endpoint is configured.
