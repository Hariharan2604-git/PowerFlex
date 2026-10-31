# PowerFlex Slurm advisory adapter

This is a local, read-only integration path for Slurm. It can query a Slurm controller with `scontrol show jobs --json` or consume a saved Slurm JSON snapshot. It emits candidate start times and a separate local job-ID mapping. It never calls `sbatch`, `scontrol update`, `scontrol hold`, `scontrol release`, `scancel`, or any other scheduler mutation command.

## What the adapter requires

PowerFlex refuses to recommend a move unless the inputs include all of these:

- A real job deadline from Slurm's `deadline` field or an operator-supplied, authorized due-time map.
- A runtime forecast in 15-minute increments. Slurm's `time_limit` is checked as a maximum allowed runtime; it is not treated as a runtime forecast or a completion deadline.
- A measured or validated per-job power profile, in kW, with one value per 15-minute runtime interval.
- 96 local facility baseline power readings or forecasts (kW), 96 electricity prices (USD/MWh), and 96 carbon-intensity values (kg CO2e/MWh), all UTC-aligned to the 24-hour horizon.
- An explicitly configured power ceiling and maximum 15-minute ramp.
- Concise `powerProvenance`, `priceProvenance`, and `carbonProvenance` strings. These are copied into the report but are not authenticated or independently checked.

The heuristic supports up to 50 eligible jobs in each 24-hour planning window. It does not model a full cluster's GPU topology, network fabric, reservations, fairness policy, job dependencies, or simultaneous resource feasibility. Treat output as a review queue for an operator, not as a Slurm plan or guarantee.

## Run against a saved snapshot

Capture a snapshot on a Slurm login/management node using the read-only command:

```sh
scontrol show jobs --json > slurm-jobs.json
```

Prepare the signal file using the schema below, then run. Inputs are limited to 64 MiB for the Slurm snapshot and 1 MiB for the signal file. Numeric arrays must contain JSON numbers (numeric strings are rejected), and timestamps must carry explicit time-zone information. `horizonStartUtc` must end in `Z`.

```sh
node outputs/powerflex/scheduler-adapters/slurm-advisory.mjs \
  --snapshot slurm-jobs.json \
  --signals site-signals.json \
  --out advisory.json \
  --mapping-out private-job-map.json
```

Live mode runs that same read-only query from the current shell:

```sh
node outputs/powerflex/scheduler-adapters/slurm-advisory.mjs \
  --live --signals site-signals.json \
  --out advisory.json \
  --mapping-out private-job-map.json
```

The current workspace has no `scontrol` executable or configured Slurm connection, so live mode must be run from an authorized cluster environment. Do not copy a raw snapshot into the public demo or repository.

By default the adapter refuses to replace existing output files. Use `--force` only when you deliberately want to replace both named outputs. It rejects symbolic-link output destinations, output/input path collisions, and identical advisory/mapping paths. It writes each output through a same-directory temporary file and requests owner-only permissions (`0600`) where the filesystem supports them. Keep the private map in an approved local directory; the adapter cannot determine whether a chosen directory is backed by network or cloud storage.

## Signal-file schema

The planning horizon begins at the next UTC quarter-hour boundary. The 96 values in each array describe consecutive 15-minute intervals starting at `horizonStartUtc`.

```json
{
  "schemaVersion": "powerflex.slurm-advisory-signals.v1",
  "horizonStartUtc": "2026-10-31T18:00:00.000Z",
  "horizonHours": 24,
  "intervalMinutes": 15,
  "objective": "lowcarbon",
  "powerCeilingKW": 900,
  "maximum15MinuteRampKW": 150,
  "facilityBaselineKW": ["96 actual/forecast values"],
  "electricityPriceUSDPerMWh": ["96 actual tariff/price values"],
  "carbonIntensityKgPerMWh": ["96 aligned carbon values"],
  "dueTimeUtcByJobId": {"123456": "2026-10-31T22:00:00Z"},
  "jobEstimates": {
    "123456": {
      "estimatedDurationMinutes": 60,
      "baselineStartUtc": "2026-10-31T19:00:00Z",
      "powerProfileKW": ["four measured/validated 15-minute values"]
    }
  },
  "powerProvenance": "meter/model, revision, and scope",
  "priceProvenance": "site tariff or authorized interval-price feed, units, source",
  "carbonProvenance": "site or regional feed, units, source, and accounting scope"
}
```

The example values above are illustrative and must be replaced with valid site data; a literal string in an array is rejected. `dueTimeUtcByJobId` is optional only when the Slurm JSON contains actual deadlines. When data is absent or cannot be validated, the adapter reports blockers and does not silently substitute synthetic deadlines, prices, or carbon values.

## Output and privacy

- `advisory.json` contains generated `JOB-###` aliases, proposed UTC start/completion times, signal provenance, constraint metrics, and cost/carbon deltas. It omits names, users, accounts, paths, and Slurm IDs. Provenance strings are copied to this report, so keep secrets, hostnames, and identifying internal details out of them.
- `private-job-map.json` contains only the alias-to-Slurm-job-ID mapping needed by an authorized operator. The adapter writes both files with owner-only permissions where supported. Keep the mapping local and do not publish it.
- The adapter has no network client and does not upload files. In live mode its only scheduler call is `scontrol show jobs --json`. The operator chooses the output paths, so do not place either file in a shared or synchronized directory unless approved.
- The adapter executes the repository-owned scheduling function locally. JSON inputs are parsed as data and never evaluated as code; review project code before running it in a sensitive cluster environment.
- An advisory still requires human approval and a separate, reviewed scheduler workflow. This adapter has no apply mode by design.

## Evaluation semantics

The comparison uses the current eligible-time/estimated-start plan as its baseline and the PowerFlex schedule as a counterfactual. It reports total cost and carbon under the supplied interval profiles, job completion deadlines, requested Slurm wallclock limits, the site power ceiling, and ramp limit. It does not claim that a regional average carbon series is a facility or marginal-emissions measurement, or that a market LMP is the facility's retail bill. Preserve source, units, timezone, signal cadence, missing-data policy, and billing/settlement scope with every evaluation.
