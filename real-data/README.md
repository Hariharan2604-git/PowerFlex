# PowerFlex real-data sample

This folder contains a privacy-minimized, reproducible evaluation of a public NLR Eagle GPU-node trace. It pairs one UTC day of measured whole-node iLO power with three eligible anonymized GPU jobs, then replays their estimated measured profiles through PowerFlex's scheduler.

An expanded three-snapshot, six-node comparison is available in [broad/evaluation_report.md](broad/evaluation_report.md). It adds 466 fully measured node-day windows and an EIA regional carbon-intensity proxy. The broad replay is a sensitivity study because the public trace has no true deadlines or site-aligned electricity prices.

The read-only Slurm connection and current data gaps are documented in [advisory_evaluation_readiness.md](advisory_evaluation_readiness.md). The adapter is in [../scheduler-adapters/](../scheduler-adapters/). It requires actual due-time inputs, measured/validated runtime and power profiles, and 24-hour time-aligned site power, price, and carbon feeds. This workspace has no authorized live Slurm connection, and the currently available public traces do not contain all those fields.

## Files

- `evaluation_report.md` — observed trace results, scheduler replay, units, time zones, cleaning, assumptions, and limits.
- `evaluation_summary.json` — machine-readable data-cleaning summary, measured results, and source hashes.
- `optimizer_evaluation.json` — compact baseline-versus-PowerFlex comparison.
- `powerflex_real_data_run_report.json` — complete scenario, schedules, traces, and constraint metrics.
- `observed_node_power_15min.csv` — 96 elapsed 15-minute whole-node power averages in kW; no node identifier or wall-clock timestamps.
- `anonymized_gpu_jobs.csv` — three matched jobs with generated IDs; no source job, user, account, script, path, or node identifiers.
- `scenario.json` — sanitized import scenario for the PowerFlex browser prototype.
- `prepare_eagle_sample.py` — standard-library-only preparation script; the source node selector is used locally and never written to outputs.
- `run_evaluation.mjs` — runs the scheduler functions embedded in `../index.html` against `scenario.json`.
- `DATA_LICENSE_NOTICE.txt` — full required NLR data-use notice and attribution.

## Run and interact

Prepare sanitized files from the public source downloads using the command in `evaluation_report.md`. Then run:

```sh
node outputs/powerflex/real-data/run_evaluation.mjs
python3 outputs/powerflex/verify_run_report.py outputs/powerflex/real-data/powerflex_real_data_run_report.json
```

To explore the replay, open `../index.html`, select **Load scenario JSON**, and choose `scenario.json`. The browser app keeps imported data local and displays this sample in kW. Its cap and ramp values are data-derived stress-test thresholds, not operating limits.

## Data sources and use

- [NLR / NREL HPC Eagle Jobs Data, submission 152](https://data.nlr.gov/submissions/152)
- [NLR HPC Eagle GPU Node Metrics, submission 301](https://data.nlr.gov/submissions/301)
- [NLR data-use license](https://data.nlr.gov/node/301/license)

NLR describes the representative GPU node as two CPUs plus two GPUs. The iLO meter is whole-node watts, not GPU-only or facility power. The legacy job trace's `avg_power` field is excluded because its unit and aggregation scope are unspecified. The sample has three jobs, synthetic deadlines, and no aligned price/carbon profiles; the scheduler replay is a small prototype evaluation and does not establish savings or facility impact.
