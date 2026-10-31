# PowerFlex real-data evaluation: NLR Eagle GPU node sample

## Result at a glance

I evaluated one public, anonymized day of Eagle GPU-node telemetry, paired with three eligible completed single-node GPU jobs. This is a small node-level replay, not a benchmark of a company, cluster, or facility.

The observed trace contains **1,440 one-minute meter samples** and has readings in all **96** 15-minute intervals.

| Measure | Observed result |
|---|---:|
| Mean whole-node power | 0.422 kW |
| 95th percentile instantaneous power | 0.427 kW |
| Peak instantaneous power | 0.724 kW |
| 95th percentile 15-minute mean | 0.458 kW |
| Peak 15-minute mean | 0.559 kW |
| 95th percentile absolute 15-minute ramp | 0.044 kW |
| Largest absolute 15-minute ramp | 0.144 kW |
| Estimated meter energy over the UTC day | 10.127 kWh |
| Matched completed GPU jobs | 3 |
| Matched job runtime range | 20.1–49.5 minutes |
| Matched job queue-wait range | 33–303 seconds |

The per-job meter means were 0.409, 0.497, and 0.408 kW; their measured whole-node peaks were 0.417, 0.576, and 0.414 kW. These include CPUs, GPUs, memory, fans, and other node components; they are not GPU-only measurements.

## Scheduler replay

I loaded the measured scenario into the same PowerFlex scheduler used by the prototype. The replay uses the measured 15-minute node trace and profiles estimated from whole-node meter readings above a 407 W median idle estimate. The reconstructed reference curve has zero RMSE **by construction**: the background is formed by subtracting the selected job profiles from the observed 15-minute means. This is not an independent model-accuracy result.

| Metric | Observed-start reference | PowerFlex replay | Change |
|---|---:|---:|---:|
| Peak 15-minute power | 0.559 kW | 0.615 kW | **9.9% higher** |
| Largest 15-minute ramp | 0.144 kW | 0.127 kW | **12.3% lower** |
| Power-ceiling violation intervals | 5 | 3 | 2 fewer |
| Ramp-limit violation intervals | 5 | 5 | unchanged |
| Missed deadlines | n/a | 0 of 3 | deadlines are synthetic |
| Replay energy | 10.134 kWh | 10.134 kWh | same to reported precision |

The replay shifts one job by 45 minutes and leaves two at their observed starts. PowerFlex improves the ramp metric and reduces ceiling-violation intervals, but **worsens the peak** and still violates both configured limits. The generated deadlines give jobs up to 60 minutes of synthetic slack after observed completion, rounded to 15-minute slots and capped at the next release to prevent overlap. They are not real service-level deadlines.

The ceiling is the observed 95th percentile 15-minute mean (0.458 kW); the ramp limit is the 95th percentile absolute 15-minute change (0.044 kW). These are data-derived stress-test thresholds, not engineering or safety limits. The source does not include electricity prices or carbon-intensity profiles, so those objectives and savings are not evaluated.

## Source and authorization

- [NLR / NREL HPC Eagle Jobs Data, submission 152](https://data.nlr.gov/submissions/152): public anonymized monthly Slurm job records, including UTC timestamps and job/node metadata.
- [NLR HPC Eagle GPU Node Metrics, submission 301](https://data.nlr.gov/submissions/301): public time-series data for representative GPU nodes. The catalog README defines `vl` as watts for iLO power and describes the GPU nodes as two CPUs plus two GPUs each.
- [NLR data-use license](https://data.nlr.gov/node/301/license): permits use and copying with the full notice and DOE/NREL/ALLIANCE attribution; those names cannot be used to imply endorsement.

Dataset citations: Eash and Egan (2020), DOI [10.7799/1722950](https://doi.org/10.7799/1722950); Clark (2025), DOI [10.7799/3015213](https://doi.org/10.7799/3015213). The project is independent; no company or laboratory has endorsed it.

## Units and time zones

- Source meter `vl`: instantaneous whole-node power in **W**.
- `observed_node_power_15min.csv`: arithmetic mean of valid one-minute readings in each UTC 15-minute interval, converted to **kW** by dividing watts by 1,000.
- PowerFlex's imported schema stores power in **MW**; the app displays this sample in **kW** for readability.
- Per-job energy: trapezoidal integration of readings over adjacent samples, reported in **Wh**; intervals over 300 seconds are omitted.
- Job runtime and queue wait: seconds in the anonymized job export. Derived job event offsets are elapsed minutes from the UTC window start, rounded to 15 minutes.
- Source timestamps use UTC (`Z`). The selected window is `2019-12-11 00:00` through `2019-12-12 00:00 UTC`. The sanitized demo exports elapsed offsets instead of source wall-clock timestamps.

## Cleaning and anonymization

1. Read the December 2019 JSON Lines job file and match GPU-partition records to the locally selected node and UTC day.
2. Retain completed jobs assigned to exactly one node. Exclude jobs overlapping another recorded job on the selected node, with fewer than two meter readings, or with meter gaps over five minutes.
3. Read the iLO CSV, select the same node locally, parse timestamps as UTC, sort them, and average duplicate timestamps. Drop invalid, non-finite, or negative readings. Do not clip valid positive readings.
4. Average readings into 96 fixed 15-minute UTC bins. All bins have readings, so no interpolation is used. Median and maximum source meter intervals are 60 and 61 seconds.
5. Estimate idle power as the median reading in bins with no recorded job. Estimate each job's profile as non-negative whole-node watts above that idle estimate, averaged by 15-minute interval and converted to MW. This is a simple attribution assumption; meter data does not isolate a job's causal power draw.
6. Replace job identifiers with `GPU-01` to `GPU-03`; omit source job IDs, user/account hashes, names, scripts, paths, and node identifiers. The legacy job trace's `avg_power` field is excluded because its unit and aggregation scope are not specified in catalog metadata.

Raw source files and the local node selector are kept outside `outputs/`. The deliverable folder contains only sanitized aggregates, generated job IDs, the scenario, and the required license notice.

## Assumptions and limits

- This is one representative Eagle GPU node over one UTC day, not facility load or a statistically representative workload sample.
- The one-minute source was resampled to 15 minutes, so short transients are lost. The 0.724 kW instantaneous peak is from the original source; the largest 15-minute mean is 0.559 kW.
- Job power is approximated by subtracting a median idle estimate from whole-node power. Other node activity and component-level contributions may be mixed into each profile.
- The profile's 15-minute bins, synthetic slack, and cap/ramp thresholds do not represent a scheduler SLA or a safe operating envelope.
- Cost and emissions are not evaluated because no aligned price or grid-carbon series is provided.
- This replay is a reproducible prototype evaluation, not a production-scheduler comparison, savings claim, operational guarantee, or company endorsement.

## Reproduce

Keep raw source files outside `outputs/`. Prepare the sanitized sample and scenario:

```sh
python3 outputs/powerflex/real-data/prepare_eagle_sample.py \
  --jobs /path/to/anon_jobs_2019-12.json.bz2 \
  --power-csv /path/to/extracted-node-ilo.csv \
  --node-id <source-node-selector> \
  --out outputs/powerflex/real-data
```

Run the scheduler replay and independently verify the exported report:

```sh
node outputs/powerflex/real-data/run_evaluation.mjs
python3 outputs/powerflex/verify_run_report.py \
  outputs/powerflex/real-data/powerflex_real_data_run_report.json
```

To interact with the replay, open `outputs/powerflex/index.html`, choose **Load scenario JSON**, and select `outputs/powerflex/real-data/scenario.json`. The app processes it locally in the browser. `DATA_LICENSE_NOTICE.txt` contains the full data-use notice and attribution.
