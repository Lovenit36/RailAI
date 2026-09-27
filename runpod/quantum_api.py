from __future__ import annotations

import hashlib
import json
import math
import os
import threading
import time
from typing import Dict, List, Tuple

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from qiskit import QuantumCircuit, transpile
from qiskit.circuit import Parameter
from qiskit_aer import AerSimulator

AER_DEVICE = os.environ.get("RAILAI_AER_DEVICE", "CPU").upper()
app = FastAPI(title="RailAI Quantum Service", version="1.2.0")
sim = AerSimulator(method="statevector", device=AER_DEVICE)
SOLVE_LOCK = threading.Lock()
CACHE_TTL_SECONDS = 20.0
CACHE: Dict[str, Tuple[float, dict]] = {}


class SolveRequest(BaseModel):
    labels: List[str] = Field(min_length=3, max_length=3)
    costs: List[List[float]]
    penalty: float = 100.0
    shots: int = Field(default=512, ge=128, le=16384)
    seed: int = 42


def build_qubo(costs: List[List[float]], penalty: float):
    if len(costs) != 3 or any(len(row) != 3 for row in costs):
        raise ValueError("costs must be a 3x3 matrix")

    n = 9
    linear = np.zeros(n, dtype=float)
    quadratic = np.zeros((n, n), dtype=float)
    constant = 0.0
    for i in range(3):
        for j in range(3):
            linear[i * 3 + j] += float(costs[i][j])

    groups = []
    groups.extend([[i * 3 + j for j in range(3)] for i in range(3)])
    groups.extend([[i * 3 + j for i in range(3)] for j in range(3)])
    for group in groups:
        constant += penalty
        for q in group:
            linear[q] -= penalty
        for a in range(len(group)):
            for b in range(a + 1, len(group)):
                i, j = sorted((group[a], group[b]))
                quadratic[i, j] += 2.0 * penalty
    return linear, quadratic, constant


def state_result(index: int, labels: List[str], costs: List[List[float]], penalty: float):
    bits = [(index >> q) & 1 for q in range(9)]
    rows = [sum(bits[i * 3 + j] for j in range(3)) for i in range(3)]
    cols = [sum(bits[i * 3 + j] for i in range(3)) for j in range(3)]
    feasible = rows == [1, 1, 1] and cols == [1, 1, 1]

    delay = 0.0
    order = ["", "", ""]
    for i in range(3):
        for j in range(3):
            if bits[i * 3 + j]:
                delay += float(costs[i][j])
                order[j] = labels[i]

    energy = delay + penalty * sum((v - 1) ** 2 for v in rows + cols)
    return {
        "bits": format(index, "09b"),
        "energy": float(energy),
        "feasible": feasible,
        "order": order,
        "delay": float(delay),
    }


def ising_terms(linear: np.ndarray, quadratic: np.ndarray):
    n = len(linear)
    h = np.zeros(n, dtype=float)
    jzz = np.zeros((n, n), dtype=float)
    for i in range(n):
        h[i] -= linear[i] / 2.0
    for i in range(n):
        for j in range(i + 1, n):
            q = quadratic[i, j]
            if q:
                h[i] -= q / 4.0
                h[j] -= q / 4.0
                jzz[i, j] += q / 4.0
    return h, jzz


def build_parameterized_qaoa(h: np.ndarray, jzz: np.ndarray, scale: float, measure: bool = False):
    gamma = Parameter("gamma")
    beta = Parameter("beta")
    qc = QuantumCircuit(9)
    qc.h(range(9))
    for q in range(9):
        if h[q]:
            qc.rz(2.0 * gamma * float(h[q]) / scale, q)
    for i in range(9):
        for j in range(i + 1, 9):
            if jzz[i, j]:
                qc.rzz(2.0 * gamma * float(jzz[i, j]) / scale, i, j)
    for q in range(9):
        qc.rx(2.0 * beta, q)
    if measure:
        qc.measure_all()
    else:
        qc.save_statevector()
    return qc, gamma, beta


def evaluate_batch(compiled: QuantumCircuit, gamma_param: Parameter, beta_param: Parameter, points: List[Tuple[float, float]], energies: np.ndarray):
    circuits = [compiled.assign_parameters({gamma_param: gamma, beta_param: beta}, inplace=False) for gamma, beta in points]
    result = sim.run(circuits).result()
    evaluated = []
    for index, (gamma, beta) in enumerate(points):
        sv = np.asarray(result.get_statevector(index), dtype=complex)
        probabilities = np.abs(sv) ** 2
        expected = float(np.dot(probabilities, energies))
        evaluated.append((expected, gamma, beta, probabilities))
    return evaluated


def cache_key(req: SolveRequest) -> str:
    payload = {
        "labels": req.labels,
        "costs": [[round(float(v), 3) for v in row] for row in req.costs],
        "penalty": round(float(req.penalty), 3),
        "shots": req.shots,
        "seed": req.seed,
    }
    return hashlib.sha1(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()


@app.get("/health")
def health():
    return {"status": "ok", "devices": sim.available_devices(), "device": AER_DEVICE, "solver": "9-qubit-p1-qaoa-batched", "qubo": "3x3 assignment / 9 binary variables / 6 one-hot constraints", "version": "1.2.0"}


@app.post("/qubo")
def inspect_qubo(req: SolveRequest):
    try:
        linear, quadratic, constant = build_qubo(req.costs, req.penalty)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    states = [state_result(i, req.labels, req.costs, req.penalty) for i in range(512)]
    feasible = [state for state in states if state["feasible"]]
    classical = min(feasible, key=lambda state: state["energy"])
    couplers = [
        {"i": i, "j": j, "value": float(quadratic[i, j])}
        for i in range(9) for j in range(i + 1, 9) if quadratic[i, j] != 0
    ]
    print(
        f"[QUBO] BUILT {', '.join(req.labels)} · vars=9 · constraints=6 · couplers={len(couplers)} · feasible={len(feasible)} · classical={' > '.join(classical['order'])}",
        flush=True,
    )
    return {
        "labels": req.labels,
        "variables": 9,
        "constraints": 6,
        "linear": [float(v) for v in linear],
        "quadratic": couplers,
        "constant": float(constant),
        "feasibleStates": len(feasible),
        "classicalOptimum": classical,
        "penalty": req.penalty,
    }


@app.post("/solve")
def solve(req: SolveRequest):
    request_started = time.perf_counter()
    key = cache_key(req)
    cached = CACHE.get(key)
    if cached and request_started - cached[0] <= CACHE_TTL_SECONDS:
        answer = dict(cached[1])
        answer["cacheHit"] = True
        answer["runtime"] = (time.perf_counter() - request_started) * 1000.0
        print(f"[QAOA] CACHE {', '.join(req.labels)} · {answer['runtime']:.1f} ms", flush=True)
        return answer

    queued_at = time.perf_counter()
    with SOLVE_LOCK:
        started = time.perf_counter()
        queue_ms = (started - queued_at) * 1000.0
        print(f"[QAOA] START {', '.join(req.labels)} · shots={req.shots} · queue={queue_ms:.0f} ms", flush=True)
        try:
            linear, quadratic, _ = build_qubo(req.costs, req.penalty)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        coupler_count = int(np.count_nonzero(np.triu(quadratic, 1)))
        print(f"[QUBO] BUILT {', '.join(req.labels)} · vars=9 · constraints=6 · couplers={coupler_count} · penalty={req.penalty:g}", flush=True)

        states = [state_result(i, req.labels, req.costs, req.penalty) for i in range(512)]
        energies = np.array([s["energy"] for s in states], dtype=float)
        feasible = [s for s in states if s["feasible"]]
        classical = min(feasible, key=lambda s: s["energy"])

        h, jzz = ising_terms(linear, quadratic)
        scale = max(1.0, float(np.max(np.abs(h))), float(np.max(np.abs(jzz))))

        compile_started = time.perf_counter()
        qc, gamma_symbol, beta_symbol = build_parameterized_qaoa(h, jzz, scale, measure=False)
        compiled = transpile(qc, sim, optimization_level=1, seed_transpiler=req.seed)
        gamma_param = next(p for p in compiled.parameters if p.name == "gamma")
        beta_param = next(p for p in compiled.parameters if p.name == "beta")
        compile_ms = (time.perf_counter() - compile_started) * 1000.0

        # Fast p=1 search: 48-point coarse scan + 16-point local refinement = 64 evaluations.
        search_started = time.perf_counter()
        coarse = [
            ((gi + 0.5) * 2.0 * math.pi / 8.0, (bi + 0.5) * math.pi / 6.0)
            for gi in range(8)
            for bi in range(6)
        ]
        coarse_eval = evaluate_batch(compiled, gamma_param, beta_param, coarse, energies)
        best_expected, best_gamma, best_beta, best_probabilities = min(coarse_eval, key=lambda item: item[0])

        gamma_step = 2.0 * math.pi / 8.0
        beta_step = math.pi / 6.0
        offsets = (-0.375, -0.125, 0.125, 0.375)
        refine = [
            ((best_gamma + go * gamma_step) % (2.0 * math.pi), min(math.pi - 1e-6, max(1e-6, best_beta + bo * beta_step)))
            for go in offsets
            for bo in offsets
        ]
        refine_eval = evaluate_batch(compiled, gamma_param, beta_param, refine, energies)
        refined = min(refine_eval, key=lambda item: item[0])
        if refined[0] < best_expected:
            best_expected, best_gamma, best_beta, best_probabilities = refined
        evaluations = len(coarse) + len(refine)
        search_ms = (time.perf_counter() - search_started) * 1000.0

        sample_started = time.perf_counter()
        sample_qc, sample_gamma, sample_beta = build_parameterized_qaoa(h, jzz, scale, measure=True)
        sample_compiled = transpile(sample_qc, sim, optimization_level=1, seed_transpiler=req.seed)
        sample_gamma_param = next(p for p in sample_compiled.parameters if p.name == "gamma")
        sample_beta_param = next(p for p in sample_compiled.parameters if p.name == "beta")
        bound_sample = sample_compiled.assign_parameters({sample_gamma_param: best_gamma, sample_beta_param: best_beta}, inplace=False)
        counts_raw = sim.run(bound_sample, shots=req.shots, seed_simulator=req.seed).result().get_counts(0)
        sample_ms = (time.perf_counter() - sample_started) * 1000.0

        counts = np.zeros(512, dtype=int)
        for bitstring, count in counts_raw.items():
            counts[int(bitstring.replace(" ", ""), 2)] += int(count)

        measured_feasible = [states[i] for i in range(512) if states[i]["feasible"] and counts[i] > 0]
        quantum = min(measured_feasible, key=lambda s: s["energy"]) if measured_feasible else None
        feasibility = float(sum(counts[i] for i in range(512) if states[i]["feasible"]) / req.shots)

        distribution = []
        for i, count in enumerate(counts):
            if count <= 0:
                continue
            distribution.append({
                "bits": states[i]["bits"],
                "energy": states[i]["energy"],
                "feasible": states[i]["feasible"],
                "probability": float(best_probabilities[i]),
                "count": int(count),
            })
        distribution.sort(key=lambda x: x["count"], reverse=True)

        runtime_ms = (time.perf_counter() - started) * 1000.0
        answer = {
            "classical": classical,
            "quantum": quantum,
            "distribution": distribution,
            "expectedEnergy": best_expected,
            "feasibility": feasibility,
            "shots": req.shots,
            "gamma": best_gamma,
            "beta": best_beta,
            "qubits": 9,
            "evaluations": evaluations,
            "runtime": runtime_ms,
            "compileMs": compile_ms,
            "searchMs": search_ms,
            "sampleMs": sample_ms,
            "costs": req.costs,
            "penalty": req.penalty,
            "labels": req.labels,
            "seed": req.seed,
            "device": AER_DEVICE,
            "solver": "QAOA-p1-batched-coarse-refine",
            "cacheHit": False,
        }
        CACHE[key] = (time.perf_counter(), answer)
        # Avoid unbounded cache growth in long demos.
        if len(CACHE) > 64:
            oldest = min(CACHE.items(), key=lambda item: item[1][0])[0]
            CACHE.pop(oldest, None)
        order = quantum["order"] if quantum else []
        print(
            f"[QAOA] DONE {', '.join(req.labels)} · evals={evaluations} · compile={compile_ms:.0f} ms · search={search_ms:.0f} ms · sample={sample_ms:.0f} ms · total={runtime_ms:.0f} ms · order={' > '.join(order) if order else 'none'}",
            flush=True,
        )
        return answer
