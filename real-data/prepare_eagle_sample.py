#!/usr/bin/env python3
"""Create a privacy-minimized one-day Eagle GPU node trace summary.

Inputs are the public December 2019 anonymized Eagle job JSONL.bz2 and an
extracted NLR iLO CSV for one representative GPU node. The node selector is
provided at run time and is never written to any output file.
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
DAY_START = dt.datetime(2019, 12, 11, tzinfo=UTC)
DAY_END = DAY_START + dt.timedelta(days=1)
STEP_SECONDS = 900


def parse_time(value: str | None) -> dt.datetime | None:
    if not value:
        return None
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Expected timezone-aware source timestamp")
    return parsed.astimezone(UTC)


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    if not ordered:
        raise ValueError("Cannot calculate percentile of an empty list")
    position = (len(ordered) - 1) * fraction
    low = math.floor(position)
    high = math.ceil(position)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def integrate_wh(samples: list[tuple[dt.datetime, float]], max_gap_seconds: int) -> float:
    total_watt_seconds = 0.0
    for (time_a, watts_a), (time_b, watts_b) in zip(samples, samples[1:]):
        seconds = (time_b - time_a).total_seconds()
        if 0 < seconds <= max_gap_seconds:
            total_watt_seconds += (watts_a + watts_b) * 0.5 * seconds
    return total_watt_seconds / 3600.0


def source_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_jobs(path: Path, node_id: str) -> tuple[list[dict], list[dict]]:
    all_node_jobs: list[dict] = []
    with bz2.open(path, "rt", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            nodes = row.get("nodelist") or []
            if node_id not in nodes:
                continue
            submit = parse_time(row.get("submit_time"))
            start = parse_time(row.get("start_time"))
            end = parse_time(row.get("end_time"))
            item = {
                "partition": row.get("partition"),
                "state": row.get("state"),
                "nodes": nodes,
                "submit": submit,
                "start": start,
                "end": end,
            }
            if start and end and start < DAY_END and end > DAY_START:
                all_node_jobs.append(item)

    eligible = [
        item
        for item in all_node_jobs
        if item["partition"] == "gpu"
        and item["state"] == "COMPLETED"
        and item["nodes"] == [node_id]
        and item["submit"] is not None
        and item["start"] is not None
        and item["end"] is not None
        and DAY_START <= item["start"] < item["end"] <= DAY_END
    ]
    eligible.sort(key=lambda item: item["start"])
    return all_node_jobs, eligible


def load_power(path: Path, node_id: str) -> tuple[list[tuple[dt.datetime, float]], dict]:
    raw_rows = 0
    invalid_rows = 0
    invalid_rows_in_window = 0
    rows: list[tuple[dt.datetime, float]] = []
    with path.open("r", newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        required = {"__time", "dv", "vl"}
        if not required.issubset(reader.fieldnames or []):
            raise ValueError(f"iLO CSV must contain columns {sorted(required)}")
        for row in reader:
            if row.get("dv") != node_id:
                continue
            timestamp = None
            try:
                timestamp = parse_time(row.get("__time"))
                watts = float(row.get("vl", ""))
                if timestamp is None or not math.isfinite(watts) or watts < 0:
                    invalid_rows += 1
                    if timestamp is not None and DAY_START <= timestamp < DAY_END:
                        invalid_rows_in_window += 1
                    continue
            except (TypeError, ValueError):
                invalid_rows += 1
                if timestamp is not None and DAY_START <= timestamp < DAY_END:
                    invalid_rows_in_window += 1
                continue
            raw_rows += 1
            if DAY_START <= timestamp < DAY_END:
                rows.append((timestamp, watts))

    rows.sort(key=lambda item: item[0])
    by_timestamp: dict[dt.datetime, list[float]] = defaultdict(list)
    for timestamp, watts in rows:
        by_timestamp[timestamp].append(watts)
    duplicate_timestamp_count = sum(len(values) - 1 for values in by_timestamp.values())
    clean = [(timestamp, statistics.mean(values)) for timestamp, values in by_timestamp.items()]
    clean.sort(key=lambda item: item[0])
    return clean, {
        "matchingNodeRowsInSource": raw_rows,
        "invalidOrNegativeRowsDroppedAcrossTrace": invalid_rows,
        "invalidOrNegativeRowsDroppedInSelectedWindow": invalid_rows_in_window,
        "duplicateRowsCollapsedByTimestamp": duplicate_timestamp_count,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jobs", type=Path, required=True, help="NLR anon_jobs_2019-12.json.bz2")
    parser.add_argument("--power-csv", type=Path, required=True, help="Extracted NLR iLO per-node CSV")
    parser.add_argument("--node-id", required=True, help="Source node selector; never written to outputs")
    parser.add_argument("--out", type=Path, required=True, help="Output directory")
    args = parser.parse_args()

    all_node_jobs, jobs = load_jobs(args.jobs, args.node_id)
    power, power_cleaning = load_power(args.power_csv, args.node_id)
    if not power:
        raise SystemExit("No valid meter readings in the selected UTC day")

    intervals = [(time_b - time_a).total_seconds() for (time_a, _), (time_b, _) in zip(power, power[1:])]
    expected_seconds = statistics.median(intervals)
    max_gap = max(intervals, default=0)
    if expected_seconds <= 0:
        raise SystemExit("Could not infer a positive sensor sampling interval")

    bins: dict[int, list[float]] = defaultdict(list)
    for timestamp, watts in power:
        slot = int((timestamp - DAY_START).total_seconds() // STEP_SECONDS)
        if 0 <= slot < 96:
            bins[slot].append(watts)
    empty_bins = [slot for slot in range(96) if not bins[slot]]
    if empty_bins:
        raise SystemExit(f"Missing 15-minute telemetry bins: {empty_bins}")

    bin_means = [statistics.mean(bins[slot]) for slot in range(96)]
    ramps = [abs(right - left) for left, right in zip(bin_means, bin_means[1:])]
    sample_values = [watts for _, watts in power]
    idle_samples: list[float] = []
    for slot in range(96):
        bin_start = DAY_START + dt.timedelta(seconds=slot * STEP_SECONDS)
        bin_end = bin_start + dt.timedelta(seconds=STEP_SECONDS)
        occupied = any(item["start"] < bin_end and item["end"] > bin_start for item in all_node_jobs)
        if not occupied:
            idle_samples.extend(bins[slot])
    if not idle_samples:
        raise SystemExit("Could not estimate a node idle baseline from unoccupied intervals")
    idle_baseline_w = statistics.median(idle_samples)

    max_gap_by_job: list[float] = []
    job_rows: list[dict] = []
    scenario_jobs: list[dict] = []
    for index, job in enumerate(jobs, start=1):
        overlaps = [
            other
            for other in all_node_jobs
            if other is not job
            and other["start"] < job["end"]
            and other["end"] > job["start"]
        ]
        if overlaps:
            continue
        readings = [(time, watts) for time, watts in power if job["start"] <= time <= job["end"]]
        if len(readings) < 2:
            continue
        gaps = [(right[0] - left[0]).total_seconds() for left, right in zip(readings, readings[1:])]
        if max(gaps, default=0) > 300:
            continue
        runtime_seconds = (job["end"] - job["start"]).total_seconds()
        queue_seconds = (job["start"] - job["submit"]).total_seconds()
        job_rows.append({
            "demoJobId": f"GPU-{len(job_rows) + 1:02d}",
            "releaseOffsetMinutesUTC_rounded15m": round((job["submit"] - DAY_START).total_seconds() / STEP_SECONDS) * 15,
            "observedStartOffsetMinutesUTC_rounded15m": round((job["start"] - DAY_START).total_seconds() / STEP_SECONDS) * 15,
            "observedEndOffsetMinutesUTC_rounded15m": round((job["end"] - DAY_START).total_seconds() / STEP_SECONDS) * 15,
            "queueWaitSeconds_roundedMinute": round(queue_seconds / 60) * 60,
            "runtimeSeconds_rounded5Minutes": round(runtime_seconds / 300) * 300,
            "meterSamples": len(readings),
            "meterMaxGapSeconds": round(max(gaps, default=0), 2),
            "meanNodePowerW": round(statistics.mean(value for _, value in readings), 3),
            "peakNodePowerW": round(max(value for _, value in readings), 3),
            "measuredNodeEnergyWh_trapezoid": round(integrate_wh(readings, max_gap_seconds=300), 3),
        })
        runtime_slots = math.ceil(runtime_seconds / STEP_SECONDS)
        measured_profile_mw: list[float] = []
        for relative_slot in range(runtime_slots):
            interval_start = job["start"] + dt.timedelta(seconds=relative_slot * STEP_SECONDS)
            interval_end = min(job["end"], interval_start + dt.timedelta(seconds=STEP_SECONDS))
            interval_samples = [watts for timestamp, watts in readings if interval_start <= timestamp < interval_end]
            if not interval_samples:
                raise SystemExit(f"No meter samples for retained demo job {len(job_rows):02d} interval {relative_slot}")
            active_seconds = max(0.0, (interval_end - interval_start).total_seconds())
            mean_delta_w = statistics.mean(max(0.0, watts - idle_baseline_w) for watts in interval_samples)
            measured_profile_mw.append(round(mean_delta_w * min(1.0, active_seconds / STEP_SECONDS) / 1_000_000, 9))

        release_slot = round((job["submit"] - DAY_START).total_seconds() / STEP_SECONDS)
        observed_slot = max(release_slot, round((job["start"] - DAY_START).total_seconds() / STEP_SECONDS))
        synthetic_deadline_slot = math.ceil((job["end"] + dt.timedelta(minutes=60) - DAY_START).total_seconds() / STEP_SECONDS)
        scenario_jobs.append({
            "id": f"GPU-{len(scenario_jobs) + 1:02d}",
            "releaseHour": release_slot * 0.25,
            "baselineStartHour": observed_slot * 0.25,
            "deadlineHour": synthetic_deadline_slot * 0.25,
            "durationHours": runtime_slots * 0.25,
            "peakPowerMW": max(measured_profile_mw),
            "powerProfileMW": measured_profile_mw,
            "phaseOffset": 0,
        })
        max_gap_by_job.extend(gaps)

    # Prevent the three jobs on this single node from being scheduled concurrently.
    for index, job in enumerate(scenario_jobs[:-1]):
        next_release = scenario_jobs[index + 1]["releaseHour"]
        job["deadlineHour"] = min(job["deadlineHour"], next_release)
        if job["releaseHour"] + job["durationHours"] > job["deadlineHour"]:
            raise SystemExit("Synthetic non-overlap window does not fit a retained workload")

    background_w = list(bin_means)
    for job in scenario_jobs:
        start_slot = round(job["baselineStartHour"] / 0.25)
        for offset, delta_mw in enumerate(job["powerProfileMW"]):
            if start_slot + offset < len(background_w):
                background_w[start_slot + offset] -= delta_mw * 1_000_000
    if min(background_w) < 0:
        raise SystemExit("Measured job profiles exceed the observed baseline; cannot form a nonnegative background")

    evaluation_settings = {
        "powerCeilingMW": round(percentile(bin_means, 0.95) / 1_000_000, 9),
        "maximum15MinuteRampMW": round(percentile(ramps, 0.95) / 1_000_000, 9),
        "objective": "stability",
        "syntheticDeadlineSlackMinutes": 60,
        "powerScope": "one representative GPU node; whole-node power",
    }

    args.out.mkdir(parents=True, exist_ok=True)
    power_csv = args.out / "observed_node_power_15min.csv"
    with power_csv.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["interval_index", "elapsed_hour_utc", "mean_node_power_kW", "source_sample_count"])
        for slot, value in enumerate(bin_means):
            writer.writerow([slot, f"{slot * 0.25:.2f}", f"{value / 1000:.6f}", len(bins[slot])])

    jobs_csv = args.out / "anonymized_gpu_jobs.csv"
    if job_rows:
        with jobs_csv.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=list(job_rows[0]))
            writer.writeheader()
            writer.writerows(job_rows)

    scenario = {
        "schemaVersion": "powerflex.scenario.v1",
        "name": "NLR Eagle single-node measured trace replay",
        "horizonHours": 24,
        "intervalMinutes": 15,
        "powerDisplayUnit": "kW",
        "powerScope": "one representative GPU node, whole-node power",
        "dataProvenance": "Public NLR Eagle anonymized job events paired with measured NLR iLO whole-node power. One-node trace; no company data.",
        "facilityBaselineMW": [round(value / 1_000_000, 9) for value in background_w],
        "carbonIntensityKgPerMWh": [0.0] * 96,
        "electricityPriceUSDPerMWh": [0.0] * 96,
        "jobs": scenario_jobs,
        "evaluationSettings": evaluation_settings,
    }
    (args.out / "scenario.json").write_text(json.dumps(scenario, indent=2) + "\n", encoding="utf-8")

    summary = {
        "schemaVersion": "powerflex.real-data-eval.v1",
        "dataset": "NLR Eagle anonymized jobs + Eagle iLO GPU-node telemetry",
        "datasetReferences": [
            "https://data.nlr.gov/submissions/152",
            "https://data.nlr.gov/submissions/301",
        ],
        "citation": "Eash, Matthew, and Hilary Egan. 2020. NREL HPC Eagle Jobs Data. NLR Data Catalog. DOI: 10.7799/1722950. Clark, Struan. 2025. NLR HPC Eagle GPU Node Metrics. NLR Data Catalog. DOI: 10.7799/3015213.",
        "windowUtc": {"start": DAY_START.isoformat(), "endExclusive": DAY_END.isoformat()},
        "timeZone": "Source meter timestamps carry Z (UTC); job timestamps are timezone-aware Z timestamps. Derived exports use elapsed minutes from the UTC window start.",
        "units": {
            "sourceMeterValue": "W (instantaneous whole-node iLO power)",
            "derivedPowerCsv": "kW (mean of source W readings in each 15-minute UTC interval; W / 1000)",
            "jobEnergy": "Wh (trapezoidal integration of W readings over adjacent samples; gaps over 300 seconds excluded)",
            "jobTimes": "seconds or elapsed minutes, as named",
        },
        "scope": "One representative Eagle GPU node over one UTC day. This is node telemetry, not facility load. Only completed, single-node GPU jobs with unambiguous non-overlapping node occupancy and continuous meter coverage are included in the per-job table.",
        "cleaning": {
            "jobRowsForSelectedNodeAndDay": len(all_node_jobs),
            "eligibleCompletedGpuJobsBeforeTelemetryChecks": len(jobs),
            "jobsRetainedAfterOverlapAndCoverageChecks": len(job_rows),
            "powerSamplesInWindow": len(power),
            "powerSampleIntervalMedianSeconds": round(expected_seconds, 2),
            "powerSampleIntervalMaximumSeconds": round(max_gap, 2),
            "power15MinuteBins": 96,
            "emptyPowerBins": len(empty_bins),
            "estimatedIdleBaselineW": round(idle_baseline_w, 3),
            **power_cleaning,
            "duplicateTimestamps": "Rows sharing a timestamp are averaged; source node identifier is only used as a local filter and is omitted from exports.",
            "invalidValues": "Non-numeric, non-finite, or negative meter readings are discarded; zero-valued readings are retained; no valid source readings in the selected day were clipped or winsorized.",
            "missingIntervals": "The selected day has a meter value in every 15-minute bin. No values are interpolated.",
            "jobPowerField": "The legacy job avg_power field is deliberately excluded because its unit and aggregation scope are not specified in the catalog metadata.",
            "jobOverlap": "Jobs that overlap another recorded job on the selected node are excluded from the per-job power table to avoid attributing shared node watts to one job.",
        },
        "measuredResults": {
            "meanNodePower_kW": round(statistics.mean(sample_values) / 1000, 6),
            "p95NodePower_kW": round(percentile(sample_values, 0.95) / 1000, 6),
            "peakNodePower_kW": round(max(sample_values) / 1000, 6),
            "p95NodePower15MinuteMean_kW": round(percentile(bin_means, 0.95) / 1000, 6),
            "peak15MinuteMean_kW": round(max(bin_means) / 1000, 6),
            "max15MinuteRamp_kW": round(max(ramps, default=0) / 1000, 6),
            "p95Abs15MinuteRamp_kW": round(percentile(ramps, 0.95) / 1000, 6) if ramps else 0,
            "estimatedMeterEnergy_kWh": round(integrate_wh(power, max_gap_seconds=300) / 1000, 6),
            "anonymizedJobs": job_rows,
        },
        "assumptionsAndLimits": [
            "The public data license and attribution notice apply; this output contains derived aggregates and no source job, user, account, script, or node identifiers.",
            "NLR describes each sampled Eagle GPU node as containing two CPUs and two GPUs. Whole-node iLO power includes the full node and is not GPU-only power.",
            "The 15-minute resampling matches PowerFlex's interval, but erases sub-15-minute transients.",
            "The accompanying PowerFlex replay has mixed results: the peak increases while the largest 15-minute ramp and ceiling-violation count decrease. This small replay does not establish generalizable optimizer savings, real SLA/deadline performance, facility-level impact, or company endorsement.",
            "No price or carbon profile is joined; cost and emissions are not evaluated.",
            "The scenario input estimates node idle baseline as the median meter reading from 15-minute intervals with no recorded job on the node. Job profiles are measured whole-node watts above that idle estimate, converted to MW.",
            "Synthetic deadlines add up to 60 minutes after the observed finish (rounded to 15-minute intervals) and are capped at the next job release to preserve single-node non-overlap. The source has no contractual deadlines.",
        ],
        "evaluationSettings": evaluation_settings,
        "inputSha256": {
            "jobsSource": source_hash(args.jobs),
            "extractedMeterCsv": source_hash(args.power_csv),
        },
    }
    (args.out / "evaluation_summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "jobsRetained": len(job_rows),
        "powerSamples": len(power),
        "meanNodePower_kW": summary["measuredResults"]["meanNodePower_kW"],
        "peakNodePower_kW": summary["measuredResults"]["peakNodePower_kW"],
        "max15MinuteRamp_kW": summary["measuredResults"]["max15MinuteRamp_kW"],
        "scenarioJobs": len(scenario_jobs),
        "output": str(args.out),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
