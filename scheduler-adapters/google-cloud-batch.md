# Google Cloud Batch advisory integration

PowerFlex can read queued jobs from Google Cloud Batch and calculate candidate start windows with the same scheduling model used by the browser prototype. The integration is a local Node.js command-line adapter. It calls the Cloud Batch v1 `projects.locations.jobs.list` method using Google Application Default Credentials (ADC), then produces an anonymized advisory report and a separate owner-only mapping file.

The adapter is intentionally read-only. It does not create, cancel, delete, update, or reschedule Cloud Batch jobs. A recommendation is a counterfactual for an operator to review; Cloud Batch will continue its own scheduling unless an approved, separately engineered workflow acts on that recommendation.

## What comes from Cloud Batch, and what does not

The live API provides Batch job resources and states. PowerFlex considers `QUEUED` jobs only. `SCHEDULED` jobs are counted and excluded because Batch has already begun preparing them for resource allocation. Running and terminal jobs are excluded.

Cloud Batch does not provide the site-specific completion deadline, interval electricity tariff, facility power baseline, carbon-intensity series, runtime forecast, or a measured per-job electrical profile required by this model. Those are supplied in local JSON files. The adapter never substitutes a task runtime limit for a runtime forecast or a user completion deadline.

The model supports a single-task job in one TaskGroup. It does not model GPU topology, parallel task groups, network-fabric constraints, Batch queueing policy, quotas, zone capacity, fairness, prerequisites, or placement availability. For that reason, the output is an operator review artifact and not a replacement Batch scheduler.

## Prerequisites

- Node.js 18 or newer (the adapter uses the built-in `fetch` API).
- Google Cloud CLI installed and configured for the intended identity.
- The Cloud Batch API enabled in the selected project.
- The identity used by ADC granted the least-privilege **Batch Job Viewer** role (`roles/batch.jobsViewer`) on the project. An administrator can grant it; do not use Owner, Editor, or Batch Job Editor for this read-only integration.
- A local job-profile file and 24-hour site-signal file, both authorized for this evaluation.

For local ADC setup, use `gcloud auth application-default login`. Avoid service-account key files and never paste access tokens or credentials into the repository. Google recommends attached service accounts for production workloads; use a narrowly scoped service identity if this adapter is later run from a managed environment.

## Local profile file

Create `batch-profiles.json` in an approved local directory. The object is keyed by the leaf job ID from the Cloud Batch resource name. Do not commit internal job IDs, user data, or site profiles to the public repository.

```json
{
  "schemaVersion": "powerflex.google-batch-profiles.v1",
  "jobs": {
    "batch-job-123": {
      "deadlineUtc": "2026-11-02T06:00:00Z",
      "releaseUtc": "2026-11-01T23:00:00Z",
      "baselineStartUtc": "2026-11-02T00:00:00Z",
      "estimatedDurationMinutes": 60,
      "powerProfileKW": [120, 145, 150, 140],
      "profileProvenance": "authorized meter-derived job profile; units kW; 15-minute mean"
    }
  }
}
```

The example values are illustrative only. Replace them with authorized data. `deadlineUtc` must be the actual completion due time or SLA. `releaseUtc` is optional; if absent, the adapter uses Cloud Batch `createTime` as the earliest-eligible proxy. `baselineStartUtc` is optional; when absent, it uses the release time as a counterfactual earliest-start baseline. This is not a forecast of Cloud Batch's actual start time. `powerProfileKW` must contain one positive value for every 15 minutes of the runtime forecast and must represent the total power envelope for the modeled one-task job.

## Site signals file

Create `site-signals.json` with 96 values for each series, aligned to a 15-minute UTC horizon:

```json
{
  "schemaVersion": "powerflex.google-batch-signals.v1",
  "horizonStartUtc": "2026-11-02T00:00:00Z",
  "horizonHours": 24,
  "intervalMinutes": 15,
  "objective": "balanced",
  "powerCeilingKW": 900,
  "maximum15MinuteRampKW": 150,
  "facilityBaselineKW": ["replace with 96 numeric kW values"],
  "electricityPriceUSDPerMWh": ["replace with 96 numeric USD/MWh values"],
  "carbonIntensityKgPerMWh": ["replace with 96 numeric kg CO2e/MWh values"],
  "powerProvenance": "meter or validated forecast; scope, source, and revision",
  "priceProvenance": "authorized site tariff or measured interval-price feed; units and scope",
  "carbonProvenance": "authorized carbon feed; units, geography, scope, and method"
}
```

The placeholder arrays above are deliberately invalid; every item must be a JSON number and each array must contain exactly 96 values. Prices may be negative. The horizon must start on a UTC quarter-hour boundary. Record the source, units, timezone, cadence, scope, and missing-data handling in provenance. The adapter copies provenance strings into the advisory, so keep secrets, hostnames, and identifying details out of them.

## Run against Google Cloud Batch

Enable the API if needed, then authenticate with ADC and run the adapter:

```sh
gcloud services enable batch.googleapis.com --project=YOUR_PROJECT_ID
gcloud auth application-default login
node scheduler-adapters/google-batch-advisory.mjs \
  --project YOUR_PROJECT_ID \
  --location us-central1 \
  --profiles batch-profiles.json \
  --signals site-signals.json \
  --out powerflex-advisory.json \
  --mapping-out powerflex-private-map.json
```

The live path makes paginated GET requests to the Cloud Batch v1 jobs-list endpoint for only the specified project and location. It does not send the local profile or site-signal files to Google Cloud. It writes the report and the separate job-resource mapping locally. Output files are created with owner-only permissions where the filesystem supports them, and existing files are not replaced unless `--force` is provided.

For an offline, saved response from the Batch `jobs.list` API, add `--snapshot batch-jobs.json`. Snapshot mode makes no Google API call and allows a historical `horizonStartUtc`; live mode requires a horizon beginning at the next UTC quarter-hour or later.

## Report and privacy boundary

- The report uses `JOB-001` aliases and does not include Batch job names, resource paths, project ID, or location.
- The private mapping file contains alias-to-resource-name entries, plus project and location, and must stay in an approved local directory. Do not publish or share it.
- The adapter reads full job resources into process memory but only emits the fields needed for the advisory. It does not request task logs or runnable scripts.
- Google OAuth access tokens are obtained from the local ADC command and held in process memory for API requests; they are not printed or saved by the adapter.
- Cloud Batch list errors suppress response bodies to avoid leaking project data in terminal output.
- No scheduler mutation is performed. Recommendations can become stale as queued jobs, signals, or resource availability change.

This is a prototype security boundary, not an enterprise security certification. Review source code and data handling before use in a sensitive project. A production integration would still need organizational approval, threat modeling, audit and retention design, operational monitoring, a secure deployment, and a supervised application path.

## Evidence and limitations

The adapter is implemented against the documented Cloud Batch v1 API and ADC flow, but it has not been run against a live Google Cloud project in this workspace. No Google Cloud project ID, authorization, Batch trace, or site meter/tariff/carbon feed was available here. A live API run and a multi-day evaluation with real deadlines and measured signals remain outstanding.

Existing PowerFlex public-trace analysis is limited and mixed. In the broader sensitivity analysis, only 4 of 22 one-job candidate cases changed: the regional carbon proxy improved in 2, worsened in 2, and was unchanged in 18, with a mean change of +0.0013%. The available data has no user due-time deadlines or site price feed. This is not a Cloud Batch benchmark and it does not establish that PowerFlex improves cost, carbon, throughput, or reliability generally.

## Google references

- [Cloud Batch `jobs.list` REST reference](https://cloud.google.com/batch/docs/reference/rest/v1/projects.locations.jobs/list)
- [Cloud Batch job and state resource reference](https://cloud.google.com/batch/docs/reference/rest/v1/projects.locations.jobs)
- [Batch IAM roles and permissions](https://cloud.google.com/iam/docs/roles-permissions/batch)
- [Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials)
- [Google Dev Library](https://devlibrary.withgoogle.com/about)
