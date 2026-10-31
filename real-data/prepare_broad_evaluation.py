#!/usr/bin/env python3
"""Prepare a privacy-minimized multi-window PowerFlex trace evaluation.

The public job and meter files are read from user-selected local paths. Source
node IDs and job/user/account/script fields are used only for matching and are
never written to outputs. Requires openpyxl to read the official EIA workbook.
"""

from __future__ import annotations

import argparse
import bz2
import csv
import datetime as dt
import hashlib
import json
import math
import statistics
from collections import defaultdict
from pathlib import Path

UTC = dt.timezone.utc
STEP_SECONDS = 900
SLOTS_PER_DAY = 96
LB_PER_KWH_TO_KG_PER_MWH = 453.59237


def parse_time(value):
    if not value:
        return None
    parsed = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Expected timezone-aware job or meter timestamps")
    return parsed.astimezone(UTC)


def ceil_slot(value: dt.datetime, day: dt.datetime) -> int:
    seconds = (value - day).total_seconds()
    return math.ceil(seconds / STEP_SECONDS - 1e-12)


def nearest_slot(value: dt.datetime, day: dt.datetime) -> int:
    seconds = (value - day).total_seconds()
    return math.floor(seconds / STEP_SECONDS + 0.5)


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    low, high = math.floor(position), math.ceil(position)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_carbon(path: Path):
    try:
        import openpyxl
    except ImportError as exc:
        raise SystemExit("Install openpyxl to read the official EIA workbook") from exc
    workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
    sheet = workbook["Published Hourly Data"]
    header = next(sheet.iter_rows(min_row=1, max_row=1, values_only=True))
    names = {str(name): index for index, name in enumerate(header) if name is not None}
    time_index = names["UTC time"]
    intensity_index = names["CO2 Emissions Intensity for Consumed Electricity"]
    carbon = {}
    invalid = 0
    for row in sheet.iter_rows(min_row=2, values_only=True):
        stamp = row[time_index]
        if not isinstance(stamp, dt.datetime):
            continue
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=UTC)
        else:
            stamp = stamp.astimezone(UTC)
        value = row[intensity_index]
        try:
            lbs_per_kwh = float(value)
            if not math.isfinite(lbs_per_kwh) or lbs_per_kwh < 0:
                raise ValueError
        except (TypeError, ValueError):
            invalid += 1
            continue
        # EIA's timestamp marks the end of the one-hour reporting interval.
        hour_start = stamp - dt.timedelta(hours=1)
        carbon[hour_start] = lbs_per_kwh * LB_PER_KWH_TO_KG_PER_MWH
    workbook.close()
    return carbon, invalid


def load_meters(paths: list[Path], selected_months: set[str]):
    meters = defaultdict(lambda: defaultdict(list))
    source_nodes = set()
    counts = {"rowsRead": 0, "invalidDropped": 0, "duplicateRowsCollapsed": 0}
    for path in paths:
        with path.open("r", newline="", encoding="utf-8") as handle:
            reader = csv.DictReader(handle)
            fields = set(reader.fieldnames or [])
            time_column = "__time" if "__time" in fields else "ts"
            if time_column not in fields or not {"dv", "vl"}.issubset(fields):
                raise ValueError(f"Unexpected iLO columns in {path}")
            for row in reader:
                try:
                    stamp = parse_time(row.get(time_column))
                    watts = float(row.get("vl", ""))
                    if stamp is None or not math.isfinite(watts) or watts < 0:
                        raise ValueError
                except (TypeError, ValueError):
                    counts["invalidDropped"] += 1
                    continue
                counts["rowsRead"] += 1
                month = stamp.strftime("%Y-%m")
                if month not in selected_months:
                    continue
                node = row["dv"]
                source_nodes.add(node)
                day = stamp.replace(hour=0, minute=0, second=0, microsecond=0)
                meters[node][day].append((stamp, watts))
    # Average duplicate readings at the same node/timestamp.
    for node, days in meters.items():
        for day, readings in list(days.items()):
            grouped = defaultdict(list)
            for stamp, watts in readings:
                grouped[stamp].append(watts)
            counts["duplicateRowsCollapsed"] += sum(len(values) - 1 for values in grouped.values())
            days[day] = sorted((stamp, statistics.mean(values)) for stamp, values in grouped.items())
    return meters, source_nodes, counts


def load_jobs(paths: list[Path], selected_months: set[str], nodes: set[str]):
    occupied = defaultdict(list)
    candidates = defaultdict(list)
    counts = {"sourceRecordsRead": 0, "recordsMatchingSampledNodes": 0,
              "completedSingleNodeGpuCandidates": 0}
    for path in paths:
        with bz2.open(path, "rt", encoding="utf-8") as handle:
            for line in handle:
                if not line.strip():
                    continue
                counts["sourceRecordsRead"] += 1
                row = json.loads(line)
                row_nodes = row.get("nodelist") or []
                matched = set(row_nodes).intersection(nodes)
                if not matched:
                    continue
                counts["recordsMatchingSampledNodes"] += 1
                submit = parse_time(row.get("submit_time"))
                start = parse_time(row.get("start_time"))
                end = parse_time(row.get("end_time"))
                if start and end and end > start:
                    cursor = start.replace(hour=0, minute=0, second=0, microsecond=0)
                    last = end.replace(hour=0, minute=0, second=0, microsecond=0)
                    while cursor <= last:
                        if cursor.strftime("%Y-%m") in selected_months:
                            for node in matched:
                                occupied[(node, cursor)].append({"start": start, "end": end})
                        cursor += dt.timedelta(days=1)
                if (row.get("partition") == "gpu" and row.get("state") == "COMPLETED"
                        and len(row_nodes) == 1 and row_nodes[0] in nodes
                        and submit and start and end and start < end
                        and start.strftime("%Y-%m") in selected_months
                        and start.date() == end.date() == submit.date()):
                    counts["completedSingleNodeGpuCandidates"] += 1
                    candidates[(row_nodes[0], start.replace(hour=0, minute=0, second=0, microsecond=0))].append(
                        {"submit": submit, "start": start, "end": end}
                    )
    for key in occupied:
        occupied[key].sort(key=lambda item: (item["start"], item["end"]))
    for key in candidates:
        candidates[key].sort(key=lambda item: (item["start"], item["end"]))
    return occupied, candidates, counts


def build_case(node_day, readings, jobs, intervals, carbon_by_hour, case_no):
    node, day = node_day
    day_end = day + dt.timedelta(days=1)
    if len(readings) < 2:
        return None, "no_meter"
    bins = defaultdict(list)
    for stamp, watts in readings:
        if day <= stamp < day_end:
            index = int((stamp - day).total_seconds() // STEP_SECONDS)
            if 0 <= index < SLOTS_PER_DAY:
                bins[index].append(watts)
    if any(not bins[index] for index in range(SLOTS_PER_DAY)):
        return None, "missing_meter_bin"
    bin_means = [statistics.mean(bins[index]) for index in range(SLOTS_PER_DAY)]
    ramps = [abs(right - left) for left, right in zip(bin_means, bin_means[1:])]
    carbon = []
    for hour in range(24):
        hour_start = day + dt.timedelta(hours=hour)
        value = carbon_by_hour.get(hour_start)
        if value is None:
            return None, "missing_carbon_hour"
        carbon.extend([value] * 4)

    day_intervals = [item for item in intervals if item["start"] < day_end and item["end"] > day]
    idle_values = [watts for stamp, watts in readings
                   if day <= stamp < day_end
                   and not any(item["start"] <= stamp < item["end"] for item in day_intervals)]
    if not idle_values:
        return None, "no_idle_observations"
    idle_w = statistics.median(idle_values)

    retained = []
    for job in jobs:
        other_intervals = [item for item in day_intervals
                           if not (item["start"] == job["start"] and item["end"] == job["end"])]
        if any(item["start"] < job["end"] and item["end"] > job["start"] for item in other_intervals):
            continue
        job_readings = [(stamp, watts) for stamp, watts in readings if job["start"] <= stamp <= job["end"]]
        if len(job_readings) < 2:
            continue
        gaps = [(right[0] - left[0]).total_seconds() for left, right in zip(job_readings, job_readings[1:])]
        if max(gaps, default=0) > 300:
            continue

        release_slot = max(0, min(SLOTS_PER_DAY - 1, ceil_slot(job["submit"], day)))
        baseline_slot = max(release_slot, max(0, min(SLOTS_PER_DAY - 1, nearest_slot(job["start"], day))))
        duration_slots = max(1, ceil_slot(job["end"], day) - baseline_slot)
        if baseline_slot + duration_slots > SLOTS_PER_DAY:
            continue

        previous_ends = [item["end"] for item in other_intervals if item["end"] <= job["start"]]
        next_starts = [item["start"] for item in other_intervals if item["start"] >= job["end"]]
        if previous_ends:
            release_slot = max(release_slot, max(0, min(95, ceil_slot(max(previous_ends), day))))
            baseline_slot = max(baseline_slot, release_slot)
        if baseline_slot + duration_slots > SLOTS_PER_DAY:
            continue

        # Reuse the source whole-node readings to estimate a movable increment
        # in each 15-minute slot. This is not causal per-job power attribution.
        profile = []
        for offset in range(duration_slots):
            slot_start = day + dt.timedelta(seconds=(baseline_slot + offset) * STEP_SECONDS)
            slot_end = slot_start + dt.timedelta(seconds=STEP_SECONDS)
            overlap_start, overlap_end = max(slot_start, job["start"]), min(slot_end, job["end"])
            active_seconds = (overlap_end - overlap_start).total_seconds()
            samples = [watts for stamp, watts in job_readings if overlap_start <= stamp < overlap_end]
            if active_seconds <= 0 or not samples:
                profile = []
                break
            average_delta_w = statistics.mean(max(0.0, watts - idle_w) for watts in samples)
            profile.append(average_delta_w * active_seconds / STEP_SECONDS / 1_000_000)
        if not profile or max(profile) <= 0:
            continue

        # Sensitivity-only flexibility: add up to 60 minutes after observed end.
        # The source has no declared deadline, so this is never called a real SLA.
        synthetic_deadline = min(SLOTS_PER_DAY, max(baseline_slot + duration_slots,
                                  ceil_slot(job["end"], day) + 4))
        if next_starts:
            next_slot = max(0, min(SLOTS_PER_DAY, math.floor((min(next_starts) - day).total_seconds() / STEP_SECONDS)))
            synthetic_deadline = min(synthetic_deadline, next_slot)
        if baseline_slot + duration_slots > synthetic_deadline:
            continue
        if baseline_slot + duration_slots > SLOTS_PER_DAY:
            continue

        # Build an observed-start counterfactual by removing only this job's
        # estimated increment from the measured node curve.
        background = [value / 1_000_000 for value in bin_means]
        for offset, value in enumerate(profile):
            background[baseline_slot + offset] -= value
        if min(background) < -1e-9:
            continue
        background = [max(0.0, value) for value in background]
        p95 = percentile(bin_means, 0.95) / 1_000_000
        ramp_p95 = percentile(ramps, 0.95) / 1_000_000
        actual_duration = (job["end"] - job["start"]).total_seconds()
        job_id = f"JOB-{case_no:04d}"
        case_id = f"CASE-{case_no:04d}"
        scenario = {
            "schemaVersion": "powerflex.scenario.v1",
            "name": f"Measured node-day carbon shadow case {case_no:04d}",
            "horizonHours": 24,
            "intervalMinutes": 15,
            "powerDisplayUnit": "kW",
            "powerScope": "one representative GPU node; whole-node iLO power",
            "dataProvenance": "Public NLR anonymized single-node GPU job events + measured whole-node iLO telemetry; EIA-930 PSCO regional estimated consumed-electricity CO2 intensity. Regional average proxy only; no site electricity price or contractual deadline was supplied.",
            "facilityBaselineMW": [round(value, 12) for value in background],
            "carbonIntensityKgPerMWh": [round(value, 6) for value in carbon],
            "electricityPriceUSDPerMWh": [0.0] * SLOTS_PER_DAY,
            "jobs": [{
                "id": job_id,
                "releaseHour": release_slot * 0.25,
                "baselineStartHour": baseline_slot * 0.25,
                "deadlineHour": synthetic_deadline * 0.25,
                "durationHours": duration_slots * 0.25,
                "peakPowerMW": round(max(profile), 12),
                "powerProfileMW": [round(value, 12) for value in profile],
                "phaseOffset": 0,
            }],
            "evaluationSettings": {
                "powerCeilingMW": round(p95, 12),
                "maximum15MinuteRampMW": round(ramp_p95, 12),
                "objective": "carbon",
                "syntheticDeadlineSlackMinutes": 60,
                "powerScope": "one measured node; whole-node power",
                "deadlineNote": "Sensitivity-only latest finish: observed finish plus up to 60 minutes, bounded by the next recorded node job. Not a source or contractual deadline.",
            },
            "caseId": case_id,
            "windowUtcDate": day.strftime("%Y-%m-%d"),
            "caseMetadata": {
                "observedSubmitOffsetMinutesRounded15": round((job["submit"] - day).total_seconds() / STEP_SECONDS) * 15,
                "observedStartOffsetMinutesRounded15": baseline_slot * 15,
                "observedEndOffsetMinutesRounded15": round((job["end"] - day).total_seconds() / STEP_SECONDS) * 15,
                "actualQueueWaitSecondsRoundedMinute": round((job["start"] - job["submit"]).total_seconds() / 60) * 60,
                "actualRuntimeSecondsRounded5Minutes": round(actual_duration / 300) * 300,
                "meterSamples": len(job_readings),
                "meterMaxGapSeconds": round(max(gaps, default=0), 2),
                "estimatedWholeNodeIdleW": round(idle_w, 3),
            },
        }
        retained.append((scenario, job, len(job_readings), max(gaps, default=0), idle_w))

    if not retained:
        return {"case": None, "daily": {
            "utcDate": day.strftime("%Y-%m-%d"), "sampledNodeToken": None,
            "validPowerBins": SLOTS_PER_DAY, "jobsEligibleForReplay": 0,
            "meanWholeNodePower_kW": round(statistics.mean(bin_means) / 1000, 6),
            "p95WholeNodePower_kW": round(percentile(bin_means, .95) / 1000, 6),
            "peakWholeNodePower_kW": round(max(bin_means) / 1000, 6),
            "max15MinuteRamp_kW": round(max(ramps) / 1000, 6),
        }}, "no_replayable_job"

    # One independent case per job keeps all other historical node activity
    # fixed in the background, avoiding unsupported concurrent-job scheduling.
    scenarios = []
    for scenario, job, samples, max_gap, idle in retained:
        scenarios.append(scenario)
    daily = {
        "utcDate": day.strftime("%Y-%m-%d"),
        "validPowerBins": SLOTS_PER_DAY,
        "jobsEligibleForReplay": len(scenarios),
        "meanWholeNodePower_kW": round(statistics.mean(bin_means) / 1000, 6),
        "p95WholeNodePower_kW": round(percentile(bin_means, .95) / 1000, 6),
        "peakWholeNodePower_kW": round(max(bin_means) / 1000, 6),
        "max15MinuteRamp_kW": round(max(ramps) / 1000, 6),
    }
    return {"cases": scenarios, "daily": daily}, None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jobs", type=Path, action="append", required=True,
                        help="Anonymized NLR monthly .json.bz2 job trace; repeat for each month")
    parser.add_argument("--meter-csv", type=Path, action="append", required=True,
                        help="Extracted NLR per-node iLO CSV; repeat for sampled nodes")
    parser.add_argument("--carbon-xlsx", type=Path, required=True,
                        help="Official EIA PSCO hourly grid-monitor workbook")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    selected_months = set()
    for path in args.jobs:
        match = __import__("re").search(r"(20\d\d-\d\d)", path.name)
        if not match:
            raise SystemExit(f"Cannot infer YYYY-MM from job filename: {path.name}")
        selected_months.add(match.group(1))
    carbon, carbon_invalid = load_carbon(args.carbon_xlsx)
    meters, source_nodes, meter_counts = load_meters(args.meter_csv, selected_months)
    occupied, candidates, job_counts = load_jobs(args.jobs, selected_months, source_nodes)

    cases, daily_rows, rejected = [], [], defaultdict(int)
    case_counter = 0
    node_days = [(node, day) for node, days in meters.items() for day in days]
    for node_day in sorted(node_days, key=lambda item: (item[1], item[0])):
        result, reason = build_case(node_day, meters[node_day[0]][node_day[1]],
                                    candidates.get(node_day, []), occupied.get(node_day, []),
                                    carbon, case_counter + 1)
        if reason:
            rejected[reason] += 1
        if result:
            daily = result["daily"]
            daily_rows.append(daily)
            for scenario in result.get("cases", []):
                case_counter += 1
                scenario["caseId"] = f"CASE-{case_counter:04d}"
                scenario["name"] = f"Measured node-day carbon shadow case {case_counter:04d}"
                scenario["jobs"][0]["id"] = f"JOB-{case_counter:04d}"
                cases.append(scenario)

    if not cases:
        raise SystemExit("No replayable cases; inspect source coverage and timestamp filters")

    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "broad_trace_inputs.json").write_text(json.dumps({
        "schemaVersion": "powerflex.broad-trace-inputs.v1",
        "evaluationDesign": "Independent one-job counterfactuals within historical node-day gaps; other measured activity is held fixed.",
        "deadlinePolicy": "Sensitivity-only synthetic latest finish: observed finish plus up to 60 minutes, bounded by the next recorded node job. The source has no contractual or user-provided deadline.",
        "pricePolicy": "No site-aligned price input supplied; USD/MWh array is all zero and price objective is not evaluated.",
        "carbonPolicy": "EIA-930 estimated average consumed-electricity intensity for PSCO, hourly UTC values repeated across four 15-minute slots; regional proxy, not facility meter or marginal carbon.",
        "cases": cases,
    }, indent=2) + "\n", encoding="utf-8")
    (args.out / "broad_carbon_demo_scenario.json").write_text(
        json.dumps(cases[0], indent=2) + "\n", encoding="utf-8")

    carbon_rows = []
    for hour_start, intensity in sorted(carbon.items()):
        if hour_start.strftime("%Y-%m") in selected_months:
            carbon_rows.append((hour_start, intensity))
    with (args.out / "broad_carbon_proxy_hourly.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["utc_hour_start", "eia_estimated_consumption_intensity_kg_per_mwh"])
        for stamp, intensity in carbon_rows:
            writer.writerow([stamp.strftime("%Y-%m-%dT%H:%M:%SZ"), f"{intensity:.6f}"])
    with (args.out / "broad_observed_node_days.csv").open("w", newline="", encoding="utf-8") as handle:
        fieldnames = list(daily_rows[0])
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(daily_rows)
    job_rows = []
    for scenario in cases:
        job = scenario["jobs"][0]
        metadata = scenario["caseMetadata"]
        job_rows.append({
            "caseId": scenario["caseId"], "demoJobId": job["id"], "utcDate": scenario["windowUtcDate"],
            "releaseOffsetMinutesRounded15": int(job["releaseHour"] * 60),
            "observedStartOffsetMinutesRounded15": int(job["baselineStartHour"] * 60),
            "syntheticDeadlineOffsetMinutesRounded15": int(job["deadlineHour"] * 60),
            "durationMinutesRounded15": int(job["durationHours"] * 60),
            "actualQueueWaitSecondsRoundedMinute": metadata["actualQueueWaitSecondsRoundedMinute"],
            "actualRuntimeSecondsRounded5Minutes": metadata["actualRuntimeSecondsRounded5Minutes"],
            "meterSamples": metadata["meterSamples"],
            "meterMaxGapSeconds": metadata["meterMaxGapSeconds"],
        })
    with (args.out / "broad_anonymized_jobs.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(job_rows[0]))
        writer.writeheader()
        writer.writerows(job_rows)

    summary = {
        "schemaVersion": "powerflex.broad-evaluation-inputs.v1",
        "dataSources": [
            {"name": "NLR anonymized Eagle GPU job traces", "url": "https://data.nlr.gov/submissions/152"},
            {"name": "NLR Eagle GPU node iLO metrics", "url": "https://data.nlr.gov/submissions/301"},
            {"name": "EIA-930 PSCO hourly grid monitor", "url": "https://www.eia.gov/electricity/gridmonitor/knownissues/xls/PSCO.xlsx"},
        ],
        "months": sorted(selected_months),
        "sampling": {"meteredNodeCount": len(source_nodes), "meterRowsRead": meter_counts["rowsRead"],
                     "meterRowsInvalidDropped": meter_counts["invalidDropped"],
                     "duplicateMeterRowsCollapsed": meter_counts["duplicateRowsCollapsed"],
                     "jobSourceRecordsRead": job_counts["sourceRecordsRead"],
                     "jobRecordsMatchingMeteredNodes": job_counts["recordsMatchingSampledNodes"],
                     "completedSingleNodeGpuCandidates": job_counts["completedSingleNodeGpuCandidates"],
                     "completeMeteredNodeDays": len(daily_rows), "replayCases": len(cases),
                     "rejectedNodeDays": dict(rejected),
                     "carbonRowsInvalidOrMissingAcrossFullWorkbook": carbon_invalid,
                     "carbonHourlyRowsExportedForSelectedMonths": len(carbon_rows)},
        "cleaningAndTime": {
            "jobAndMeterTimestamps": "Parsed as timezone-aware UTC; offsets represented in each UTC day window.",
            "meterUnits": "Source iLO vl is instantaneous whole-node watts; scenario power is MW; CSV observed daily statistics are kW.",
            "meterCleaning": "Reject non-numeric, non-finite, or negative W; retain zero; average duplicate node/timestamp rows; require all 96 fixed 15-minute UTC bins; no interpolation.",
            "jobCleaning": "Completed GPU-partition records using exactly one sampled node; source job must start, submit, and end on one UTC date; reject overlap with other recorded occupancy, meter gaps over 300 seconds, incomplete profiles, and cases without safe 15-minute slack.",
            "carbonUnits": "EIA consumed-electricity intensity reported in lbs CO2/kWh; converted using 1 lb/kWh = 453.59237 kg/MWh.",
            "carbonAlignment": "EIA UTC time marks the end of each hourly interval; map to the preceding UTC hour and repeat its intensity across four 15-minute slots. No interpolation.",
            "anonymization": "Generated case/job IDs only; omit source job IDs, node IDs, user/account/script hashes, names, paths, and raw records.",
        },
        "sourceHashesSha256": {
            "jobs": {path.name: sha256(path) for path in args.jobs},
            "meterCsv": {f"meterSource-{index:02d}": sha256(path)
                         for index, path in enumerate(args.meter_csv, start=1)},
            "eiaWorkbook": sha256(args.carbon_xlsx),
        },
        "limitations": [
            "The public job trace contains wallclock_req as a maximum runtime, not a contractual/user-provided completion deadline.",
            "The 60-minute slack in these sensitivity cases is synthetic and cannot establish real SLA/deadline compliance.",
            "EIA values are estimated balancing-authority consumption intensity, not data-center meter carbon or marginal emissions.",
            "The sources contain no time-aligned site electricity price. Price/cost optimization is unavailable.",
            "Power is whole-node iLO measurement. Per-job increments use a median-idle subtraction assumption, not causal per-job GPU power.",
            "Cases independently move one job while holding other measured activity fixed; they are offline shadow counterfactuals, not a live Slurm integration or cluster-wide scheduler simulation.",
        ],
        "inputFileHashes": {
            **{f"jobTrace-{index:02d}": sha256(path) for index, path in enumerate(args.jobs, start=1)},
            **{f"meterSource-{index:02d}": sha256(path) for index, path in enumerate(args.meter_csv, start=1)},
            "regionalCarbonWorkbook": sha256(args.carbon_xlsx),
        },
    }
    (args.out / "broad_evaluation_inputs_summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"cases": len(cases), "nodeDays": len(daily_rows), "summary": str(args.out / "broad_evaluation_inputs_summary.json")}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
