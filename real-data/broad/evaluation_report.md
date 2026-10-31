# PowerFlex broader public-trace evaluation

## Result

This expands the original one-day sample to six representative GPU nodes and three public job-trace snapshots: December 2019, April 2020, and August 2020. The measured node telemetry spans 2019–2024; the workload snapshots cover only those three months.

| Coverage | Result |
| --- | ---: |
| Sampled GPU nodes with iLO data | 6 |
| Job records read from the three snapshots | 411,921 |
| Records assigned to a sampled node | 2,872 |
| Completed single-node GPU candidates | 44 |
| UTC node-days with all 96 measured 15-minute bins and carbon data | 466 |
| Clean one-job shadow cases with assumed slack | 22 |
| EIA hourly carbon observations joined | 2,208 |

The 22 PowerFlex cases are very small sensitivity runs. Four jobs moved at least one 15-minute interval from their recorded Slurm start. The regional carbon estimate improved in 2 cases, worsened in 2, and was unchanged in 18. Median peak, ramp, carbon-proxy, and start-time changes were all zero. The mean carbon-proxy change was **+0.0013%** (slightly higher). This run does not show a useful general improvement.

The modeled median power shift is zero because most jobs are short and the scheduler uses 15-minute slots, while the EIA signal is hourly and repeated across four slots. These data therefore do not demonstrate carbon-aware savings.

## Comparison method

- The reference is the historical Slurm start time from the anonymized job record, rounded to a 15-minute slot.
- Each counterfactual moves one completed, single-node GPU job at a time. Other measured activity on that node stays fixed, so this does not model simultaneous jobs or a full cluster scheduler.
- Whole-node iLO measurements are converted from watts to 15-minute mean kW. The scenario format stores MW. The job increment is estimated from measured whole-node power above a median idle estimate; it is not causal GPU-only power attribution.
- Cases with another recorded job overlapping the target, incomplete telemetry, a meter gap over five minutes, missing 15-minute bins, or insufficient synthetic scheduling slack are excluded.
- The PowerFlex scheduler functions embedded in `../index.html` are run offline. The current implementation is a deterministic heuristic; it does not guarantee a global optimum or run inside Slurm.

## Deadline, price, and carbon signals

The public workload records include submit, start, end, and `wallclock_req` fields. `wallclock_req` is a maximum runtime request; it is not a requested due time. **This dataset has no contractual or user-provided completion-deadline field.** The replay's up-to-60-minute latest-finish slack is a clearly marked synthetic sensitivity assumption, bounded by the next recorded node job. Therefore the deadline-miss result is not evidence of real SLA compliance.

The carbon series comes from EIA-930's hourly **estimated CO₂ intensity of consumed electricity** for the PSCO balancing authority. The workbook reports lbs CO₂/kWh; this evaluation converts by 453.59237 to kg CO₂/MWh. EIA timestamps are UTC hour-ending times, so each hourly value is assigned to the preceding UTC hour and repeated across that hour's four 15-minute slots. The selected series ranges from 324.87 to 768.54 kg CO₂/MWh, with a mean of 559.89 kg CO₂/MWh.

This is a balancing-authority average estimate, not a facility meter reading or a marginal emissions rate. It is a regional proxy for the trace study, not a claim about the carbon intensity of an individual NLR node.

No time-aligned site electricity price was available in the public trace. Price and cost optimization were not evaluated. EIA states that it does not publish hourly electricity price data; a facility's actual tariff, bill, or authorized interval-price feed is required for that measure.

## Cleaning, time zones, and privacy

- Job and meter timestamps were parsed as timezone-aware UTC. The evaluation uses UTC day windows and elapsed 15-minute bins; there is no daylight-saving conversion.
- Meter rows with non-numeric, non-finite, or negative watts were dropped; zero readings were retained. Duplicate node/timestamp rows would be averaged. No values were interpolated or clipped.
- A node-day was included only when all 96 fixed 15-minute bins had measured readings and all 24 hourly carbon values were present. This yielded 466 node-days across 88 dates.
- Candidate jobs had to be completed, in the GPU partition, allocated to exactly one sampled node, and submitted, started, and ended on one UTC date. Jobs overlapping any other recorded occupancy on that node or with meter gaps above 300 seconds were excluded.
- The public source includes anonymized hashes. Output files replace job IDs with generated `CASE-` and `JOB-` identifiers and omit source job IDs, node names, user/account/script hashes, paths, and raw records.
- All power results are representative-node measurements. They are not facility power, facility cost, facility emissions, or a company deployment result.

## Files

- `broad_evaluation_inputs_summary.json` — source counts, hashes, units, cleaning, and limitations.
- `broad_trace_inputs.json` — sanitized scenario inputs for all 22 cases.
- `broad_scheduler_results.json` — per-case recorded-Slurm vs. PowerFlex results and aggregate metrics.
- `broad_carbon_demo_scenario.json` — one locally importable case for the PowerFlex interface.
- `broad_observed_node_days.csv` — sanitized daily power summaries.
- `broad_anonymized_jobs.csv` — generated job labels and rounded timing/telemetry fields.
- `broad_carbon_proxy_hourly.csv` — regional EIA hourly carbon-intensity proxy used by the cases.
- `../DATA_LICENSE_NOTICE.txt` — NLR data-use notice and required attribution.

To inspect the carbon example, open `../index.html`, choose **Load scenario JSON**, and select `broad_carbon_demo_scenario.json`. The **Lower carbon only** objective is enabled. The imported scenario discloses its regional carbon scope and synthetic deadline assumption. Price controls remain unavailable because there is no price series.

## Reproduction

Use the three monthly public job files, the six extracted per-node iLO CSVs, and an official EIA PSCO workbook:

```sh
python outputs/powerflex/real-data/prepare_broad_evaluation.py \
  --jobs /path/to/anon_jobs_2019-12.json.bz2 \
  --jobs /path/to/anon_jobs_2020-04.json.bz2 \
  --jobs /path/to/anon_jobs_2020-08.json.bz2 \
  --meter-csv /path/to/node-1-ilo.csv \
  --meter-csv /path/to/node-2-ilo.csv \
  --meter-csv /path/to/node-3-ilo.csv \
  --meter-csv /path/to/node-4-ilo.csv \
  --meter-csv /path/to/node-5-ilo.csv \
  --meter-csv /path/to/node-6-ilo.csv \
  --carbon-xlsx /path/to/PSCO.xlsx \
  --out outputs/powerflex/real-data/broad
node outputs/powerflex/real-data/run_broad_evaluation.mjs
```

The preparer requires Python with `openpyxl` installed. Public sources: [NLR Eagle job snapshots](https://data.nlr.gov/submissions/152), [NLR Eagle GPU node metrics](https://data.nlr.gov/submissions/301), and [EIA PSCO historical workbook](https://www.eia.gov/electricity/gridmonitor/knownissues/xls/PSCO.xlsx). EIA describes these hourly CO₂ values as estimates and explains their reporting and accounting scope in [its EIA-930 documentation](https://www.eia.gov/electricity/930-content/about.html).

## What is needed for the requested production-grade evaluation

To evaluate the exact target—real deadlines against a real scheduler with measured site price and carbon—the next data package needs authorized, anonymized fields for: submission time, actual due time/SLA, requested resources, scheduler decisions, measured cluster/node power, and time-aligned site price and carbon inputs with units and timezone. Keep the source identities, job names, accounts, scripts, paths, and facility identifiers out of any shared demo.

