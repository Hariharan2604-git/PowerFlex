# PowerFlex v0.7.1

This metadata-only pre-release follows v0.7.0 so Zenodo can archive a release created after the GitHub integration was enabled. It updates `CITATION.cff` to version 0.7.1; the browser demo, scheduler, adapters, and evaluations are unchanged. No new measurements or performance claims are introduced.

The published v0.7.1 source archive has a version-specific DOI: [10.5281/zenodo.23852440](https://doi.org/10.5281/zenodo.23852440).

PowerFlex v0.7.0 is an independent prototype for inspecting candidate start-time advisories for flexible batch-compute workloads. The browser demo is local-only. The Slurm and Google Cloud Batch adapters are read-only and do not apply recommendations to a scheduler.

## Included (unchanged from v0.7.0)

- A browser-based schedule exploration prototype and deterministic synthetic benchmark.
- A local Slurm advisory adapter with validation, aliasing, and owner-only private ID mapping.
- A Google Cloud Batch v1 advisory adapter using local Application Default Credentials and a read-only jobs-list request.
- Reproducible scripts and sanitized summaries for a small public NLR Eagle trace study, including an EIA-930 regional carbon-intensity proxy.
- A developer article draft and a citation file for this version.

## Evidence carried forward from v0.7.0

The broader public-trace sensitivity analysis includes 466 complete representative-node days and 22 one-job counterfactual cases. Four cases moved at least one 15-minute interval. The regional carbon proxy improved in 2 cases, worsened in 2, and was unchanged in 18; the mean change was +0.0013% (slightly higher). This does not show a useful general improvement.

A separate one-day replay of 1,440 one-minute whole-node meter samples and three matched jobs reduced the largest 15-minute ramp by 12.3% and power-ceiling-violation intervals from five to three, while increasing the peak by 9.9%; five ramp-limit violations remained.

## Limits

- The public workload data does not provide user completion deadlines. The replay uses explicitly synthetic slack and cannot establish deadline or SLA performance.
- No time-aligned facility electricity tariff or measured site price feed was available. Cost savings were not evaluated.
- The carbon data is an hourly EIA PSCO balancing-authority estimate, not a site-meter or marginal-emissions measurement.
- The Cloud Batch adapter has not been live-validated against a Google Cloud project.
- The trace analyses are small counterfactual studies, not full-cluster scheduler comparisons, production deployments, or evidence about Google, Microsoft, NVIDIA, or any other company.

See `README.md`, `real-data/README.md`, and `real-data/broad/evaluation_report.md` for reproduction details, units, cleaning, time zones, data rights, and assumptions.
