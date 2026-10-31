# Scheduler advisory integration and evaluation readiness

**Prepared:** 2026-10-31  
**Status:** Read-only Slurm adapter implemented; complete site-level evaluation awaits authorized inputs.

## What is implemented

`../scheduler-adapters/slurm-advisory.mjs` can consume a saved Slurm JSON snapshot or read pending jobs with `scontrol show jobs --json` from an authorized cluster shell. It emits suggested start times only. No scheduler mutation command exists in the adapter. The output separates anonymized recommendation aliases from the private alias-to-job-ID map and writes both with owner-only permissions where supported.

The adapter enforces actual completion due times, Slurm wallclock limits, the configured site power ceiling, and a 15-minute ramp limit. It requires an aligned 24-hour feed of site baseline power, electricity prices, carbon intensity, runtime forecasts, and per-job power profiles. When required information is missing, it reports why a job is blocked and returns no recommendation for that job.

The current workspace has neither Slurm command-line tools nor an authorized cluster connection, so a live scheduler query could not be run here. The adapter can be run from a cluster environment with the required local authorization and signal feeds.

## Available trace evidence

The existing public-data comparison uses the anonymized NLR Eagle jobs and measured representative-node iLO power, with EIA PSCO hourly emissions intensity as a regional estimate. It contains 466 complete node-days and 22 one-job counterfactual cases. Only four jobs moved: the carbon proxy improved in two, worsened in two, and was unchanged in eighteen. The mean proxy change was +0.0013%; the median change was zero. This evidence does not show a useful general improvement.

That comparison uses up to 60 minutes of explicitly synthetic slack. Eagle's published job records have submission, start, end, and requested wallclock fields, but no actual user completion deadline. The EIA carbon measure is a balancing-authority estimate, not a site meter or marginal emissions value. No time-aligned site tariff or metered electricity price was included, so there is no cost result.

The newer public [NLR Kestrel job dataset](https://data.nlr.gov/submissions/302) is an authorized, anonymized Slurm trace with H100 GPU jobs and node-monitoring energy fields. Its published schema includes `wallclock_req` (maximum runtime), timestamps, and measured/derived energy fields, but does not list a user due-time deadline or a facility electricity tariff. A wallclock limit is a runtime cap, not a completion due time. These signals cannot be relabeled as deadlines or site prices.

## Evaluation outcome for the requested scope

| Required evidence | Available here | Evaluation status |
| --- | --- | --- |
| Authorized anonymized scheduler trace | Yes: NLR Eagle; public NLR Kestrel data catalog also documents an anonymized Slurm trace | Existing trace replay available |
| Existing scheduler baseline | Historical Slurm starts in the offline Eagle replay | Live Slurm connection unavailable |
| Actual completion due times | No in the available trace files | Not evaluated |
| Measured per-job / node power | Eagle has measured whole-node iLO data; job increments are estimated above idle. Kestrel documents node-monitoring energy fields | Partial; no site-wide power feed |
| Site electricity tariff or metered interval price | No | Cost optimization not evaluated |
| Carbon signal | EIA PSCO estimated consumption intensity is available hourly | Regional proxy only; not a site or marginal rate |
| Performance and reliability guardrails | Adapter supports due-time, wallclock, power-ceiling, and ramp constraints | Requires actual site thresholds and forecasts |

I did not generate a new cost/carbon claim by treating a regional wholesale market price as a site's retail tariff, a runtime limit as a deadline, or synthetic profiles as measured site signals.

## Inputs needed for the full evaluation

Provide an authorized, anonymized 24-hour or multi-day data package with:

1. Slurm job IDs for local matching only, submit/eligible/start/end timestamps, actual completion due time or SLA, GPU/resource requests, requested wallclock limit, and scheduler state. Do not include names, users, accounts, paths, scripts, or unhashed organization identifiers in shared outputs.
2. Runtime forecasts or measured runtimes and a measured/validated 15-minute per-job power profile.
3. Facility baseline power, the site tariff or measured interval-price feed (including demand-charge rules if cost is to include them), and carbon feed. Include units, time zones, sampling cadence, missing-data rules, location/scope, and source rights.
4. Explicit site constraints: power ceiling, maximum ramp, acceptable slowdown/throughput change, deadline-miss tolerance, restart/failure policy, priority and fairness rules, and any jobs that must never move.

The data must be authorized for this evaluation and the demo. Keep the raw trace and the local job-ID mapping private. Share only the redacted inputs and derived aggregate results approved for release.

## Reproduction of the existing public-data comparison

See [broad/evaluation_report.md](broad/evaluation_report.md) and [broad/broad_scheduler_results.json](broad/broad_scheduler_results.json). The NLR data license is included in [DATA_LICENSE_NOTICE.txt](DATA_LICENSE_NOTICE.txt). The Kestrel catalog states that users must not attempt to re-identify hashed fields and must preserve its license notice in copies.

Primary source documentation:

- [NLR Eagle Jobs Data](https://data.nlr.gov/submissions/152)
- [NLR Eagle GPU Node Metrics](https://data.nlr.gov/submissions/301)
- [NLR Kestrel Jobs Data](https://data.nlr.gov/submissions/302)
- [EIA-930 methodology and documentation](https://www.eia.gov/electricity/930-content/about.html)
- [EIA electricity grid monitor](https://www.eia.gov/electricity/gridmonitor/about)
- [Slurm `scontrol` documentation](https://slurm.schedmd.com/scontrol.html)
