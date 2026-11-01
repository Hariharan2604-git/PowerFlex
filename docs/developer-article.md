# PowerFlex: exploring power-aware batch scheduling without hiding the trade-offs

*Developer article draft — an independent project description. The findings below are exploratory and do not establish general savings or production readiness.*

Large compute workloads do not all need to start immediately. Some batch jobs can tolerate a bounded delay, while data-center operators still need to protect deadlines, throughput, and reliability. PowerFlex is a prototype for exploring whether those flexible start windows can help manage power ramps and respond to changing energy signals.

PowerFlex is deliberately an advisory tool. It compares a supplied baseline schedule with candidate start times, applies the constraints in the scenario, and shows the trade-offs. It does not control a cluster or claim that one schedule is universally better.

## What the prototype does

The browser demo lets a user adjust job windows, duration and power profiles, facility baseline power, a power ceiling, a ramp limit, and interval-based price or carbon inputs. It presents the resulting schedule and constraint outcomes, and can export a run report that records the inputs and assumptions.

Two local adapters show how an advisory workflow might connect to existing schedulers:

- The Slurm adapter can read a saved `scontrol show jobs --json` snapshot or query an authorized Slurm environment. It requires actual due times, runtime forecasts, validated job-power profiles, and aligned site signals before it recommends a move. It has no scheduler-apply path.
- The Google Cloud Batch adapter uses local Application Default Credentials to list queued jobs through the Batch v1 API. It keeps Cloud Batch identifiers in a separate local mapping file and emits alias-only recommendations. It does not modify Batch jobs, and it has not been live-validated against a Google Cloud project.

Both adapters are examples of a read-only boundary, not an enterprise security certification. Review the setup and privacy notes in [`scheduler-adapters/README.md`](../scheduler-adapters/README.md) and [`scheduler-adapters/google-cloud-batch.md`](../scheduler-adapters/google-cloud-batch.md) before using them.

## What the available trace evidence says

The broader offline study uses anonymized public NLR Eagle job snapshots, measured whole-node telemetry from six representative GPU nodes, and an hourly EIA-930 carbon-intensity estimate for the PSCO balancing authority. Across three job snapshots, 466 UTC node-days passed the completeness checks. The analysis produced 22 clean one-job counterfactual cases with explicitly assumed scheduling slack.

Only four cases moved by at least one 15-minute slot. The regional carbon proxy improved in two cases, worsened in two, and did not change in eighteen. Its mean change was **+0.0013%**, slightly higher. The median changes were zero. This experiment does **not** show a useful general improvement.

A separate one-day replay used 1,440 one-minute meter samples and three matched completed jobs. The largest 15-minute ramp fell by 12.3%, and power-ceiling-violation intervals fell from five to three, but the peak increased by 9.9% and five ramp-limit violations remained. The thresholds were derived from that trace for stress testing; they are not engineering or safety limits.

## What the evidence cannot tell us

The public job trace has submission, start, end, and requested wall-clock limits, but no real user completion deadlines. The replay therefore uses synthetic slack and cannot demonstrate SLA compliance. The carbon input is a regional average estimate, not facility telemetry or a marginal-emissions signal. There is no aligned facility electricity tariff, so cost outcomes were not evaluated.

The power is representative-node, whole-node power, not GPU-only or facility power. Jobs are replayed one at a time against historical activity; the analysis is not a full-cluster scheduling comparison. These limits matter: the observed results should not be described as energy savings, a Google Cloud benchmark, or a company deployment result.

## Reproducing the work

The repository includes sanitized inputs, preparation and replay scripts, result summaries, and the required NLR data-use notice. Follow [`real-data/README.md`](../real-data/README.md) and [`real-data/broad/evaluation_report.md`](../real-data/broad/evaluation_report.md) for units, UTC alignment, cleaning rules, data sources, and reproduction commands. Raw source traces and local node selectors are not included.

The project is available at [github.com/Hariharan2604-git/PowerFlex](https://github.com/Hariharan2604-git/PowerFlex). The interactive prototype is at [hariharan2604-git.github.io/PowerFlex](https://hariharan2604-git.github.io/PowerFlex/).

The v0.7.1 source archive is preserved in Zenodo with a version-specific DOI: [10.5281/zenodo.23852440](https://doi.org/10.5281/zenodo.23852440). This metadata-only follow-up does not add evaluation results; the findings above remain the v0.7.0 public-trace results and limitations.

## What would strengthen the next evaluation

The next meaningful step is a multi-day, authorized evaluation using real completion deadlines, measured runtime and power profiles, a site electricity-price feed, and an appropriate carbon signal. It should compare against the existing scheduler on the same workload and report deadline misses, throughput, power, cost, carbon, and reliability under stated guardrails. Until those inputs are available, PowerFlex remains a transparent prototype for exploring constraints and trade-offs.
