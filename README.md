# PowerFlex v0.7.1

PowerFlex is a local browser prototype for exploring how flexible batch-compute jobs could be moved within release/deadline windows to reduce data-center power peaks and respond to time-varying energy cost and grid emissions. It is a decision-support demo, not an operational scheduler. v0.7.1 is a metadata-only follow-up for Zenodo archiving; it adds no scheduler changes or evaluation evidence.

## Open it

Open `index.html` in a current browser. The app has no external packages, backend, telemetry, or network calls. Imported JSON is validated and used in the browser; it is not uploaded.

## Developer article and release notes

Read the evidence-bounded [developer article](docs/developer-article.md) for the prototype, adapters, trace results, and limits. See [RELEASE_NOTES.md](RELEASE_NOTES.md) for the v0.7.1 release summary and unchanged v0.7.0 evaluation evidence.


## DOI and archived source

The v0.7.1 source archive is preserved in Zenodo: [10.5281/zenodo.23852440](https://doi.org/10.5281/zenodo.23852440). For citations that should always resolve to the latest version, use the concept DOI [10.5281/zenodo.23852439](https://doi.org/10.5281/zenodo.23852439). The evaluation evidence is carried forward from v0.7.0.

## What changed in v0.4

- The schedule search ranks hard-constraint event count and total excess before the selected objective score. The heuristic no longer prefers a cheaper or lower-carbon schedule that has more modeled cap, ramp, or deadline violations.
- Job power traces now include a one-hour ramp-in and one-hour ramp-out envelope instead of jumping from zero to full peak in one interval. This is an explicit assumption, not measured GPU behavior.
- The dashboard explicitly distinguishes a schedule with no modeled violations from a best-effort schedule and shows the remaining violation counts.
- The JSON run report includes all scenario inputs, schedules, interval traces, data-provenance notes, hard-constraint metrics, optimizer settings, and the score tie-break order.
- `verify_run_report.py` independently rebuilds both schedules and power traces from the exported report, then recomputes deadlines, cap/ramp violations, energy, cost, and emissions. It uses only Python's standard library.
- A deterministic benchmark runner executes the exact scheduler functions from `index.html` on five synthetic cases, including a deliberately infeasible low-cap case. It checks repeatability, job windows, on-time completion, and expected feasibility classification.

## What changed in v0.5

- Added `scheduler-adapters/slurm-advisory.mjs`, a local read-only adapter for `scontrol show jobs --json` snapshots or authorized live Slurm state. It emits suggestions and a separate owner-only local job-ID map; it has no scheduler apply path.
- The adapter requires real due-time inputs, runtime forecasts, validated per-job power profiles, facility power limits, and UTC-aligned electricity-price and carbon feeds. A Slurm wallclock limit is only a runtime cap and is never substituted for a completion deadline.
- Added `scheduler-adapters/README.md` for the input contract, operation, and privacy boundary, plus `real-data/advisory_evaluation_readiness.md` documenting the current evidence and the data gaps preventing a full site-level evaluation.

## What changed in v0.6

- The browser scheduler now caches each job profile during a simulation and avoids allocating a full candidate schedule for every start-time trial. This reduces repeated work while preserving the same deterministic search and ranking rules.
- The Slurm CLI rejects unknown or duplicate flags, malformed timestamps without explicit time zones, non-numeric signal values, duplicate pending job IDs, oversized input files, and missing power/price/carbon provenance.
- Output destinations are checked before processing. The adapter refuses symbolic links, input/output collisions, identical advisory and private-map paths, and existing files unless `--force` is explicitly supplied. Output files are staged locally and written owner-only where supported.
- The public advisory labels source provenance as operator-supplied and not independently verified. It never includes the private job-ID map path in the advisory JSON.

## What changed in v0.7

- Added `scheduler-adapters/google-batch-advisory.mjs`, a local, read-only integration with Google Cloud Batch v1. Live mode uses Application Default Credentials to list queued jobs in one selected project and region, then combines those jobs with local deadline, runtime, power-profile, and site-signal files. See [the setup guide](scheduler-adapters/google-cloud-batch.md).
- Cloud Batch job IDs and project details are kept in a separate owner-only local mapping file. The public advisory uses aliases and the adapter has no Cloud Batch mutation path.
- Added `scheduler-adapters/google-cloud-batch.md` with setup, IAM, data schemas, privacy boundaries, evidence, and limitations. Added `docs/google-dev-library-submission.md` as a candid submission draft.
- The adapter is not live-validated against a Google Cloud project in this workspace. No credentials, project ID, or authorized site signal set was available. See the integration guide before running it.

## Run the benchmark

From this folder, run:

```sh
node benchmarks/run.mjs > benchmarks/results.json
```

The runner uses the scheduler code embedded in `index.html`, so it does not maintain a second copy of the algorithm. The inputs are intentionally synthetic. It omits timestamps so the same source produces stable JSON output. `validationChecksPassed` means the listed model invariants passed; it does not mean every scenario is feasible. Some cases are expected to remain best-effort because the selected limits cannot be met.

To independently validate a downloaded run report:

```sh
python3 verify_run_report.py /path/to/powerflex-run-report.json
```

The verifier exits nonzero if it finds a mismatch and prints a JSON summary either way.

## Current model and limitations

- Preset facility, workload, price, and carbon profiles are synthetic. The benchmark results do not represent a real data center, grid region, or company workload.
- The scheduler uses six deterministic starts and up to four coordinate-search passes. It is a heuristic; it does not guarantee feasibility when the inputs conflict or a globally optimal result.
- Each job uses an assumed symmetric four-interval (one-hour) ramp at its start and end, plus a small repeating load-shape variation. The peak value is reached during the middle of the job. Validate this shape against measured hardware data before drawing operational conclusions.
- The model uses 15-minute steps and simplified job power shapes. It omits electrical frequency response, voltage, protection systems, thermal limits, GPU-specific behavior, job dependencies, distributed-training communications, and infrastructure reliability.
- Cost and emissions are interval estimates based on supplied profiles. They are not accounting-grade results.
- Imported data is not independently verified. Confirm units, time zones, intervals, job semantics, and data rights before using or sharing a scenario.
- “No modeled hard-constraint breaches” means only that the generated trace satisfies the entered power ceiling, ramp limit, and job deadlines. It is not grid-safety certification or an operational guarantee.

## Public-data validation path

The current browser presets and benchmark are synthetic. A credible next benchmark should use authorized site telemetry or a public workload/grid pairing with careful unit and scope checks. Useful primary sources for that validation include:

- The public [NLR HPC Kestrel Jobs dataset](https://data.nlr.gov/submissions/302), which describes anonymized jobs from an HPC system with H100 GPU nodes and scheduling/energy fields. It is an HPC workload proxy, not evidence about Google, Microsoft, NVIDIA, or any other company.
- The [NLR Eagle jobs dataset](https://data.nlr.gov/submissions/152), which provides anonymized job metadata and derived power characterization for selected months. Validate the meaning and units of the older power fields before converting them into PowerFlex inputs.
- [Cambium 2024 workbooks](https://data.nlr.gov/submissions/289), which provide modeled U.S. regional cost and emissions values, not live grid conditions or a facility meter trace.

These sources are not bundled into this app, and the benchmark does not claim to have run on them. A real-data evaluation should preserve source attribution, include the transformation script, remove identifiers, and keep workload and grid measurements separate until their time zones and intervals are aligned.

A first privacy-minimized scheduler replay is available in [real-data/evaluation_report.md](real-data/evaluation_report.md). It uses public Eagle GPU-node meter data and three matched anonymized jobs with measured whole-node profiles estimated above an idle baseline. On this one-day sample, PowerFlex reduced the largest 15-minute ramp by 12.3% and cap-violation intervals from five to three, while increasing the peak by 9.9%; five ramp-limit violations remained. Deadlines are synthetic, no price/carbon profiles are present, and the result is not a facility or company benchmark. Load `real-data/scenario.json` in the browser prototype to explore the trace.

## Security posture

The browser demo remains local-only: it has no authentication, user roles, backend, telemetry, or external network calls. The Content Security Policy blocks connections and allows the application script by an exact hash. JSON imports are limited to 256 KB and validated for schema, profile lengths and numeric ranges, job count, unique IDs, and 15-minute-aligned times. Imported values are rendered as data, not executable code.

The separate Google Cloud Batch CLI adapter makes authenticated, read-only HTTPS requests to the selected Google Cloud project and region. It obtains credentials from local Application Default Credentials, requires only Batch job-view access, emits alias-only advisory JSON, and writes resource-name mappings locally with owner-only permissions where supported. It never creates, edits, cancels, deletes, or reschedules a Batch job. Review [the Google Cloud Batch integration guide](scheduler-adapters/google-cloud-batch.md) before use.

Those controls reduce exposure for this demo; they do not certify the app or its output. The advisory CLI still executes the project-owned solver code locally, and provenance labels are not independently authenticated. An enterprise pilot would still need approved hosting, SSO, role-based access, tenant isolation, encrypted transport and storage, audit and retention controls, monitoring, a threat model, and a security review. Integrations should begin read-only. Operational control would require validated data, engineering approval, and a human-supervised fail-safe path.

## Import a scenario

Use **Download template**, then supply:

- `facilityBaselineMW`: 96 values, one per 15-minute interval.
- `carbonIntensityKgPerMWh`: 96 values, one per interval.
- `electricityPriceUSDPerMWh`: 96 values, one per interval.
- `jobs`: 1–50 jobs with unique IDs and `releaseHour`, `deadlineHour`, `durationHours`, and `peakPowerMW`. Job times must use 15-minute increments. `phaseOffset` is optional and must be an integer from 0 to 7.

Then choose **Load scenario JSON**. The file must be at most 256 KB. Values stay in the browser. Do not put secrets or identifying information in files you plan to share.

## Project status

PowerFlex is an independent prototype. It includes code for a read-only Google Cloud Batch integration, but it has not been configured for or live-validated against a Google Cloud project in this workspace. No company, including Google, NVIDIA, or Microsoft, has evaluated or endorsed it. The existing public-trace evidence still lacks actual user deadlines and a site price feed, so a full deadline-, cost-, and carbon-constrained evaluation is not available yet. See `real-data/advisory_evaluation_readiness.md` and `scheduler-adapters/google-cloud-batch.md` for the exact evidence and current limits.

Google Dev Library's official page stated on 1 November 2026 that new community submissions were temporarily closed. The prepared listing is in `docs/google-dev-library-submission.md`; it has not been submitted and is not an acceptance or endorsement.

## Contributors

- Hari Haran
- Darsani SM

## License and data attribution

The original PowerFlex source code and project scripts are licensed under the MIT License; see [LICENSE](LICENSE). The copyright notice uses the project's GitHub account handle, `Hariharan2604-git`.

The MIT License applies to the project's original software, not to third-party material, video assets, or NLR-derived data and data artifacts. NLR data remains subject to its separate terms. Preserve the complete notice in [real-data/DATA_LICENSE_NOTICE.txt](real-data/DATA_LICENSE_NOTICE.txt) and the source attributions in the evaluation reports.
