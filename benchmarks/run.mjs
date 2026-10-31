#!/usr/bin/env node
// Runs the exact pure scheduler functions embedded in ../index.html.
// This makes the benchmark dependency-free and avoids maintaining a second optimizer.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.resolve(here, '..', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const start = html.indexOf('      const HORIZON = 24;');
const end = html.indexOf('      function runSimulation() {', start);
if (start < 0 || end < 0) throw new Error('Could not locate scheduler implementation in index.html.');
const applicationFunctions = html.slice(start, end);
const harness = `${applicationFunctions}\n globalThis.api = { DEFAULT_JOBS, PRESETS, phase, JOB_POWER_RAMP_INTERVALS, facilityBaseline, profileFor, buildBaseline, scheduleJobs, operatingTotals, maxValue, maxRamp, constraintMetrics, pctChange, slot, STEP_HOURS };`;
const sandbox = { console, Math, Intl, Set, Array, Number, String };
vm.runInNewContext(harness, sandbox, { filename: htmlPath });
const api = sandbox.api;

function runCase(name, presetId, workloadScale = 1, capOverride = null, rampOverride = null, expectedFeasible = false) {
  const preset = api.PRESETS[presetId];
  const profile = api.profileFor(presetId);
  const data = {
    name,
    facilityBaselineMW: api.facilityBaseline(presetId),
    carbonKgPerMWh: profile.carbonKgPerMWh,
    priceUSDPerMWh: profile.priceUSDPerMWh,
    jobs: api.DEFAULT_JOBS.map((job) => ({ ...job, peak: job.peak * workloadScale }))
  };
  const cap = capOverride ?? preset.cap;
  const rampLimit = rampOverride ?? preset.ramp;
  const baseline = api.buildBaseline(data);
  const first = api.scheduleJobs(data, cap, rampLimit, preset.objective, baseline);
  const repeat = api.scheduleJobs(data, cap, rampLimit, preset.objective, baseline);
  const deterministic = JSON.stringify(first.schedule.map((job) => [job.id, job.startSlot])) === JSON.stringify(repeat.schedule.map((job) => [job.id, job.startSlot]))
    && JSON.stringify(first.constraints) === JSON.stringify(repeat.constraints)
    && first.objectiveScore === repeat.objectiveScore;
  const baselineTotals = api.operatingTotals(baseline.power, data);
  const managedTotals = api.operatingTotals(first.power, data);
  const baselineConstraints = api.constraintMetrics(baseline.power, baseline.schedule, cap, rampLimit);
  const onTime = first.schedule.filter((job) => job.endSlot <= api.slot(job.deadline)).length;
  const windowsValid = first.schedule.every((job) => job.startSlot >= api.slot(job.release) && job.endSlot <= api.slot(job.deadline));
  const summary = {
    scenario: name,
    provenance: 'Synthetic preset workload and grid profiles; no facility measurements.',
    objective: preset.objective,
    workloadScalePercent: Math.round(workloadScale * 100),
    inputs: { powerCeilingMW: cap, maximum15MinuteRampMW: rampLimit, jobs: data.jobs.length },
    baseline: {
      peakMW: Number(api.maxValue(baseline.power).toFixed(6)),
      max15MinuteRampMW: Number(api.maxRamp(baseline.power).toFixed(6)),
      constraints: baselineConstraints,
      energyCostUSD: Number(baselineTotals.costUSD.toFixed(2)),
      emissionsKgCO2e: Number(baselineTotals.emissionsKg.toFixed(2))
    },
    result: {
      feasible: first.constraints.feasible,
      constraints: first.constraints,
      jobsOnTime: onTime,
      peakMW: Number(api.maxValue(first.power).toFixed(6)),
      peakReductionPercent: Number((-api.pctChange(api.maxValue(baseline.power), api.maxValue(first.power))).toFixed(4)),
      max15MinuteRampMW: Number(api.maxRamp(first.power).toFixed(6)),
      energyCostUSD: Number(managedTotals.costUSD.toFixed(2)),
      energyCostDeltaPercent: Number(api.pctChange(baselineTotals.costUSD, managedTotals.costUSD).toFixed(4)),
      emissionsKgCO2e: Number(managedTotals.emissionsKg.toFixed(2)),
      emissionsDeltaPercent: Number(api.pctChange(baselineTotals.emissionsKg, managedTotals.emissionsKg).toFixed(4)),
      objectiveScore: Number(first.objectiveScore.toFixed(6))
    },
    checks: {
      deterministic,
      allJobsWithinReleaseDeadlineWindows: windowsValid,
      allJobsOnTime: onTime === data.jobs.length,
      feasibilityClassificationMatchesExpected: first.constraints.feasible === expectedFeasible
    }
  };
  const toJobs = (jobs) => jobs.map((job) => ({
    id: job.id,
    startHour: Number((job.startSlot * api.STEP_HOURS).toFixed(2)),
    endHour: Number((job.endSlot * api.STEP_HOURS).toFixed(2)),
    releaseHour: job.release,
    deadlineHour: job.deadline,
    durationHours: job.duration,
    peakPowerMW: job.peak
  }));
  const report = {
    schemaVersion: 'powerflex.run-report.v1',
    generatedAt: new Date().toISOString(),
    scenario: name,
    dataProvenance: 'Synthetic benchmark fixture; not measured facility, grid, or GPU data.',
    objective: preset.objective,
    constraints: {
      facilityPowerCeilingMW: cap,
      maximum15MinuteRampMW: rampLimit,
      workloadScalePercent: Math.round(workloadScale * 100),
      modelFeasibility: first.constraints,
      baselineFeasibility: baselineConstraints
    },
    optimizer: first.optimizer,
    objectiveScore: { value: Number(first.objectiveScore.toFixed(4)), interpretation: 'Heuristic tie-break score; it is not a cost, percentage, or optimality certificate.' },
    comparisonOrder: ['minimize hard-constraint event count', 'minimize total cap/ramp excess', 'minimize selected weighted objective score'],
    inputs: {
      facilityBaselineMW: data.facilityBaselineMW,
      carbonIntensityKgPerMWh: data.carbonKgPerMWh,
      electricityPriceUSDPerMWh: data.priceUSDPerMWh,
      jobPowerShape: api.phase,
      jobPowerRampIntervals: api.JOB_POWER_RAMP_INTERVALS,
      jobs: data.jobs.map((job) => ({ id: job.id, releaseHour: job.release, deadlineHour: job.deadline, durationHours: job.duration, peakPowerMW: job.peak, phaseOffset: job.phaseOffset || 0 }))
    },
    metrics: {
      baseline: { peakMW: api.maxValue(baseline.power), max15MinuteRampMW: api.maxRamp(baseline.power), energyMWh: baselineTotals.energyMWh, costUSD: baselineTotals.costUSD, emissionsKgCO2e: baselineTotals.emissionsKg, hardConstraints: baselineConstraints },
      powerflex: { peakMW: api.maxValue(first.power), max15MinuteRampMW: api.maxRamp(first.power), energyMWh: managedTotals.energyMWh, costUSD: managedTotals.costUSD, emissionsKgCO2e: managedTotals.emissionsKg, jobsOnTime: onTime, hardConstraints: first.constraints }
    },
    schedules: { earliestStart: toJobs(baseline.schedule), powerflex: toJobs(first.schedule) },
    timeSeries: first.power.map((powerflexMW, i) => ({ timeHour: Number((i * api.STEP_HOURS).toFixed(2)), baselineMW: data.facilityBaselineMW[i], earliestStartMW: baseline.power[i], powerflexMW, powerCeilingMW: cap, priceUSDPerMWh: data.priceUSDPerMWh[i], carbonKgPerMWh: data.carbonKgPerMWh[i] })),
    modelBoundary: 'Synthetic benchmark fixture; validate with authorized site data before operational use.'
  };
  return { summary, report };
}

const cases = [
  runCase('balanced-default', 'balanced', 1, null, null, true),
  runCase('constrained-default', 'constrained', 1, null, null, false),
  runCase('renewables-default', 'renewables', 1, null, null, true),
  runCase('balanced-125-percent-workload', 'balanced', 1.25, null, null, true),
  runCase('infeasible-low-cap', 'balanced', 1, 2.8, 0.35, false)
];
const results = cases.map((item) => item.summary);
const output = {
  benchmarkSchemaVersion: 'powerflex.benchmark.v1',
  appVersion: 'PowerFlex v0.4',
  method: 'Runs the current application scheduler twice per deterministic synthetic scenario, compares against the earliest-start schedule, and checks hard-constraint, deadline-window, and determinism invariants.',
  limitations: [
    'Scenarios are synthetic and do not establish performance on real AI or data-center workloads.',
    'This benchmark verifies repeatability and constraint reporting; it does not establish global optimality or production safety.',
    'Cost and emissions are modeled values from synthetic profiles.'
  ],
  scenarios: results,
  validationChecksPassed: results.every((item) => Object.values(item.checks).every(Boolean))
};
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
const reportArgument = process.argv.find((argument) => argument.startsWith('--write-report='));
if (reportArgument) {
  const reportPath = path.resolve(process.cwd(), reportArgument.slice('--write-report='.length));
  fs.writeFileSync(reportPath, `${JSON.stringify(cases[0].report, null, 2)}\n`);
}
if (!output.validationChecksPassed) process.exitCode = 1;
