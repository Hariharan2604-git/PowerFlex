#!/usr/bin/env python3
"""Independently check a PowerFlex v1 exported JSON run report (Python stdlib only)."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

HOURS = 24.0
STEP = 0.25
COUNT = int(HOURS / STEP)
TOL = 1e-6


def close(a: float, b: float, label: str, issues: list[str]) -> None:
    if not math.isclose(a, b, rel_tol=1e-7, abs_tol=TOL):
        issues.append(f"{label}: reported {a:.9g}, recomputed {b:.9g}")


def build_trace(baseline: list[float], jobs: list[dict], schedule: list[dict], shape: list[float], max_ramp_intervals: int, issues: list[str], historical_reference: bool = False) -> list[float]:
    power = list(baseline)
    specs = {job["id"]: job for job in jobs}
    if len(schedule) != len(jobs) or {item.get("id") for item in schedule} != set(specs):
        issues.append("schedule job IDs do not match the input job IDs")
        return power
    for item in schedule:
        job = specs[item["id"]]
        start_hour = float(item["startHour"])
        duration = float(job["durationHours"])
        end_hour = start_hour + duration
        start = round(start_hour / STEP)
        slots = round(duration / STEP)
        if abs(float(item["endHour"]) - end_hour) > TOL:
            issues.append(f"{item['id']}: reported end does not equal start plus duration")
        if abs(float(item["releaseHour"]) - float(job["releaseHour"])) > TOL or abs(float(item["deadlineHour"]) - float(job["deadlineHour"])) > TOL:
            issues.append(f"{item['id']}: schedule release/deadline differs from input")
        if start_hour < float(job["releaseHour"]) - TOL or end_hour > float(job["deadlineHour"]) + TOL:
            issues.append(f"{item['id']}: start/finish falls outside its release/deadline window")
        if abs(start_hour / STEP - start) > 1e-7 or abs(duration / STEP - slots) > 1e-7:
            issues.append(f"{item['id']}: start or duration is not aligned to 15 minutes")
        if start < 0 or start + slots > COUNT:
            issues.append(f"{item['id']}: schedule is outside the 24-hour horizon")
            continue
        if historical_reference and job.get("baselineStartHour") is not None and abs(start_hour - float(job["baselineStartHour"])) > TOL:
            issues.append(f"{item['id']}: reference schedule does not use baselineStartHour")
        if item.get("baselineStartHour") is not None and abs(float(item["baselineStartHour"]) - float(job.get("baselineStartHour"))) > TOL:
            issues.append(f"{item['id']}: schedule baselineStartHour differs from input")
        measured_profile = job.get("powerProfileMW")
        if measured_profile is not None:
            if not isinstance(measured_profile, list) or len(measured_profile) != slots:
                issues.append(f"{item['id']}: powerProfileMW length must match the job's 15-minute duration")
                continue
            for n, value in enumerate(measured_profile):
                profile_value = float(value)
                if not math.isfinite(profile_value) or profile_value < 0:
                    issues.append(f"{item['id']}: powerProfileMW must contain finite non-negative values")
                power[start + n] += profile_value
            continue
        offset = int(job.get("phaseOffset", 0))
        peak = float(job["peakPowerMW"])
        ramp_intervals = min(max_ramp_intervals, max(1, slots // 2))
        for n in range(slots):
            envelope = min(1.0, (n + 1) / ramp_intervals, (slots - n) / ramp_intervals)
            power[start + n] += peak * envelope * float(shape[(n + offset) % len(shape)])
    return power


def metrics(power: list[float], schedule: list[dict], cap: float, ramp_limit: float) -> dict:
    cap_excess = [max(0.0, value - cap) for value in power]
    ramp_excess = [max(0.0, abs(power[i] - power[i - 1]) - ramp_limit) for i in range(1, len(power))]
    cap_count = sum(value > TOL for value in cap_excess)
    ramp_count = sum(value > TOL for value in ramp_excess)
    late = sum(float(job["endHour"]) > float(job["deadlineHour"]) + TOL for job in schedule)
    return {
        "feasible": cap_count == 0 and ramp_count == 0 and late == 0,
        "capIntervals": cap_count,
        "capHours": cap_count * STEP,
        "capExcessMWh": sum(cap_excess) * STEP,
        "rampEvents": ramp_count,
        "rampExcessMW": sum(ramp_excess),
        "deadlineMisses": late,
        "totalViolationEvents": cap_count + ramp_count + late,
        "totalExcess": sum(cap_excess) + sum(ramp_excess),
    }


def verify(path: Path) -> tuple[list[str], dict]:
    issues: list[str] = []
    report = json.loads(path.read_text(encoding="utf-8"))
    if report.get("schemaVersion") != "powerflex.run-report.v1":
        raise ValueError("expected schemaVersion powerflex.run-report.v1")
    inputs = report["inputs"]
    arrays = [inputs[key] for key in ("facilityBaselineMW", "carbonIntensityKgPerMWh", "electricityPriceUSDPerMWh")]
    if any(not isinstance(array, list) or len(array) != COUNT for array in arrays):
        raise ValueError("expected three 96-value input profiles")
    baseline, carbon, price = ([float(value) for value in array] for array in arrays)
    shape = [float(value) for value in inputs["jobPowerShape"]]
    if not shape or not all(math.isfinite(value) and value >= 0 for value in shape):
        raise ValueError("jobPowerShape must contain finite non-negative values")
    ramp_intervals_value = float(inputs["jobPowerRampIntervals"])
    if not math.isfinite(ramp_intervals_value) or not ramp_intervals_value.is_integer():
        raise ValueError("jobPowerRampIntervals must be an integer")
    max_ramp_intervals = int(ramp_intervals_value)
    if max_ramp_intervals < 1 or max_ramp_intervals > 16:
        raise ValueError("jobPowerRampIntervals must be an integer from 1 to 16")
    time_series = report.get("timeSeries")
    if not isinstance(time_series, list) or len(time_series) != COUNT:
        raise ValueError("expected 96 timeSeries rows")
    cap = float(report["constraints"]["facilityPowerCeilingMW"])
    ramp_limit = float(report["constraints"]["maximum15MinuteRampMW"])
    scenarios = (
        ("baseline", "earliestStart", "earliestStartMW"),
        ("powerflex", "powerflex", "powerflexMW"),
    )
    traces: dict[str, list[float]] = {}
    for metric_key, schedule_key, trace_key in scenarios:
        schedule = report["schedules"][schedule_key]
        trace = build_trace(baseline, inputs["jobs"], schedule, shape, max_ramp_intervals, issues, historical_reference=(schedule_key == "earliestStart"))
        traces[trace_key] = trace
        for i, row in enumerate(time_series):
            close(float(row[trace_key]), trace[i], f"timeSeries[{i}].{trace_key}", issues)
    for i, row in enumerate(time_series):
        close(float(row["timeHour"]), i * STEP, f"timeSeries[{i}].timeHour", issues)
        close(float(row["baselineMW"]), baseline[i], f"timeSeries[{i}].baselineMW", issues)
        close(float(row["priceUSDPerMWh"]), price[i], f"timeSeries[{i}].priceUSDPerMWh", issues)
        close(float(row["carbonKgPerMWh"]), carbon[i], f"timeSeries[{i}].carbonKgPerMWh", issues)
        close(float(row["powerCeilingMW"]), cap, f"timeSeries[{i}].powerCeilingMW", issues)
    for name, trace_key, schedule_key, summary_key in (("baseline", "earliestStartMW", "earliestStart", "baselineFeasibility"), ("powerflex", "powerflexMW", "powerflex", "modelFeasibility")):
        trace = traces[trace_key]
        schedule = report["schedules"][schedule_key]
        calculated = metrics(trace, schedule, cap, ramp_limit)
        recorded = report["metrics"][name]
        for key, value in calculated.items():
            if key in ("feasible", "capIntervals", "rampEvents", "deadlineMisses", "totalViolationEvents"):
                if recorded["hardConstraints"].get(key) != value:
                    issues.append(f"{name}.hardConstraints.{key}: reported {recorded['hardConstraints'].get(key)!r}, recomputed {value!r}")
                if report["constraints"][summary_key].get(key) != value:
                    issues.append(f"constraints.{summary_key}.{key}: reported {report['constraints'][summary_key].get(key)!r}, recomputed {value!r}")
            else:
                close(float(recorded["hardConstraints"][key]), float(value), f"{name}.hardConstraints.{key}", issues)
                close(float(report["constraints"][summary_key][key]), float(value), f"constraints.{summary_key}.{key}", issues)
        close(float(recorded["peakMW"]), max(trace), f"{name}.peakMW", issues)
        close(float(recorded["max15MinuteRampMW"]), max(abs(trace[i] - trace[i - 1]) for i in range(1, len(trace))), f"{name}.max15MinuteRampMW", issues)
        energy = [value * STEP for value in trace]
        close(float(recorded["energyMWh"]), sum(energy), f"{name}.energyMWh", issues)
        close(float(recorded["costUSD"]), sum(energy[i] * price[i] for i in range(COUNT)), f"{name}.costUSD", issues)
        close(float(recorded["emissionsKgCO2e"]), sum(energy[i] * carbon[i] for i in range(COUNT)), f"{name}.emissionsKgCO2e", issues)
        if name == "powerflex":
            jobs_on_time = sum(float(job["endHour"]) <= float(job["deadlineHour"]) + TOL for job in schedule)
            if int(recorded["jobsOnTime"]) != jobs_on_time:
                issues.append(f"powerflex.jobsOnTime: reported {recorded['jobsOnTime']}, recomputed {jobs_on_time}")
    summary = {
        "scenario": report.get("scenario"),
        "dataProvenance": report.get("dataProvenance"),
        "powerflexFeasible": report["metrics"]["powerflex"]["hardConstraints"]["feasible"],
        "powerflexPeakMW": report["metrics"]["powerflex"]["peakMW"],
        "powerflexMaxRampMW": report["metrics"]["powerflex"]["max15MinuteRampMW"],
        "jobsOnTime": report["metrics"]["powerflex"]["jobsOnTime"],
    }
    return issues, summary


def main() -> int:
    if len(sys.argv) != 2:
        print(f"Usage: {Path(sys.argv[0]).name} powerflex-run-report.json", file=sys.stderr)
        return 2
    try:
        issues, summary = verify(Path(sys.argv[1]))
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
        print(json.dumps({"valid": False, "error": str(error)}, indent=2))
        return 1
    print(json.dumps({"valid": not issues, "summary": summary, "issues": issues}, indent=2))
    return 0 if not issues else 1


if __name__ == "__main__":
    raise SystemExit(main())
