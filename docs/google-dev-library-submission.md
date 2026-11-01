# Google Dev Library submission draft

**Status:** Prepared, not submitted. On 1 November 2026, the official Dev Library page stated that new community submissions were temporarily closed. This draft is ready to use if its submission intake reopens; it is not an acceptance, review, or Google endorsement.

## Suggested listing

- **Project title:** PowerFlex: Read-only, deadline-aware energy advisory for Google Cloud Batch
- **Google technology:** Google Cloud Batch v1 REST API and Application Default Credentials
- **Category:** Google Cloud
- **Project URL:** https://github.com/Hariharan2604-git/PowerFlex
- **Demo URL:** https://hariharan2604-git.github.io/PowerFlex/
- **Technical guide:** `scheduler-adapters/google-cloud-batch.md`
- **License:** MIT for original PowerFlex source code; third-party data and media remain under their own notices.
- **Contributors:** Hari Haran; Darsani SM

## Short description

PowerFlex is an independent, open-source prototype that reads queued Google Cloud Batch jobs through the Batch v1 API and creates local, anonymized scheduling advisories. It combines operator-supplied completion deadlines, runtime forecasts, validated job power profiles, and UTC-aligned facility power, electricity-price, and carbon signals to explore candidate start times. The adapter uses Google Application Default Credentials and the least-privilege Batch Job Viewer role. It is advisory-only: it does not modify Batch jobs or replace the Cloud Batch scheduler.

## Technical value

The integration shows how a local decision-support tool can use Google Cloud Batch's live job inventory while keeping workload profiles and site signals local. It demonstrates paginated API access, ADC-based authentication, least-privilege IAM, local identifier aliasing, a private mapping file, strict input validation, and a no-write boundary. It also explains the gap between Cloud Batch's scheduling data and the site-specific deadlines and energy signals needed for an operational evaluation.

## What a reviewer can inspect

1. The adapter at `scheduler-adapters/google-batch-advisory.mjs`.
2. The setup guide at `scheduler-adapters/google-cloud-batch.md`.
3. The browser prototype and synthetic benchmark with explicit caveats.
4. The public-data reports, including mixed results and the absence of site tariff and real completion deadlines.

## Evidence and limitations

The code uses the documented Google Cloud Batch v1 `jobs.list` API and local ADC authentication. It has not been connected to or run against a live Google Cloud project in this workspace. No company, including Google, has evaluated or endorsed PowerFlex.

The existing public-trace sensitivity analysis changed only 4 of 22 one-job cases; the regional carbon proxy improved in 2, worsened in 2, and stayed unchanged in 18. Its mean change was +0.0013%, slightly worse. The dataset does not include real completion deadlines or a site electricity price feed. Do not describe the current evidence as savings, a production result, a Google Cloud benchmark, or proof of general benefit.

The current prototype models at most 50 single-task Cloud Batch jobs per planning horizon. It omits Batch placement, quota, capacity, fairness, topology, and dependency constraints. Recommendation outputs are counterfactual and do not affect Batch behavior.

## Suggested reviewer note

This is an independent project submission for consideration by Google Dev Library. The author is not representing Google and does not claim Google affiliation, procurement interest, evaluation, or endorsement. The submission should link to the technical guide and openly state that live Cloud validation is still pending.

## Submission checklist for when intake reopens

- Confirm the official Dev Library intake is open and read its current contribution guidance.
- Confirm the repository is public and the integration guide and license are present.
- Provide the project link, technical guide, short description, Google Cloud category, and author details in the official form.
- Keep the evidence statement and limitations above intact; do not imply a live integration run until one is performed and documented.
- Save the form's confirmation email and record the submission date. Acceptance is decided by Google and is not guaranteed.
