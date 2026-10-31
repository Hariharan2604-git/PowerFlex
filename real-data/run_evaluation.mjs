#!/usr/bin/env node
// Run the exact scheduler functions embedded in ../index.html on scenario.json.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appPath = path.resolve(here, '..', 'index.html');
const scenarioPath = path.join(here, 'scenario.json');
const html = fs.readFileSync(appPath, 'utf8');
const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
const start = html.indexOf('      const HORIZON = 24;');
const end = html.indexOf('      function runSimulation() {', start);
if (start < 0 || end < 0) throw new Error('Could not locate the PowerFlex scheduler functions.');
const functions = html.slice(start, end);
const harness = `${functions}\n globalThis.api = { phase, JOB_POWER_RAMP_INTERVALS, buildBaseline, scheduleJobs, operatingTotals, maxValue, maxRamp, constraintMetrics, pctChange, slot, STEP_HOURS };`;
const sandbox = { console, Math, Intl, Set, Array, Number, String };
vm.runInNewContext(harness, sandbox, { filename: appPath });
const api = sandbox.api;
const settings = scenario.evaluationSettings;
const data = {
  name: scenario.name,
  facilityBaselineMW: scenario.facilityBaselineMW.map(Number),
  carbonKgPerMWh: scenario.carbonIntensityKgPerMWh.map(Number),
  priceUSDPerMWh: scenario.electricityPriceUSDPerMWh.map(Number),
  jobs: scenario.jobs.map((job) => ({
    id: job.id,
    release: Number(job.releaseHour),
    baselineStart: Number(job.baselineStartHour),
    deadline: Number(job.deadlineHour),
    duration: Number(job.durationHours),
    peak: Number(job.peakPowerMW),
    phaseOffset: Number(job.phaseOffset || 0),
    powerProfileMW: job.powerProfileMW.map(Number),
  })),
};
const cap = Number(settings.powerCeilingMW);
const rampLimit = Number(settings.maximum15MinuteRampMW);
const objective = String(settings.objective || 'stability');
const baseline = api.buildBaseline(data);
const managed = api.scheduleJobs(data, cap, rampLimit, objective, baseline);
const baselineTotals = api.operatingTotals(baseline.power, data);
const managedTotals = api.operatingTotals(managed.power, data);
const baselineConstraints = api.constraintMetrics(baseline.power, baseline.schedule, cap, rampLimit);
const managedConstraints = managed.constraints;
const observedRows = fs.readFileSync(path.join(here, 'observed_node_power_15min.csv'), 'utf8').trim().split(/\r?\n/).slice(1);
const observedPower = observedRows.map((line) => Number(line.split(',')[2]) / 1000);
const reconstructionErrorMW = observedPower.map((value, i) => baseline.power[i] - value);
const rmseMW = Math.sqrt(reconstructionErrorMW.reduce((sum, value) => sum + value * value, 0) / reconstructionErrorMW.length);
const toJobs = (jobs) => jobs.map((job) => ({
  id: job.id,
  startHour: Number((job.startSlot * api.STEP_HOURS).toFixed(2)),
  endHour: Number((job.endSlot * api.STEP_HOURS).toFixed(2)),
  releaseHour: job.release,
  deadlineHour: job.deadline,
  durationHours: job.duration,
  peakPowerMW: job.peak,
  baselineStartHour: job.baselineStart,
  powerProfileMW: job.powerProfileMW,
}));
const startChanges = managed.schedule.map((job) => ({
  id: job.id,
  referenceStartHour: Number((baseline.schedule.find((item) => item.id === job.id).startSlot * api.STEP_HOURS).toFixed(2)),
  powerflexStartHour: Number((job.startSlot * api.STEP_HOURS).toFixed(2)),
  shiftMinutes: (job.startSlot - baseline.schedule.find((item) => item.id === job.id).startSlot) * 15,
}));
const timeSeries = managed.power.map((powerflexMW, i) => ({
  timeHour: Number((i * api.STEP_HOURS).toFixed(2)),
  baselineMW: data.facilityBaselineMW[i],
  earliestStartMW: baseline.power[i],
  powerflexMW,
  powerCeilingMW: cap,
  priceUSDPerMWh: data.priceUSDPerMWh[i],
  carbonKgPerMWh: data.carbonKgPerMWh[i],
}));
const runReport = {
  schemaVersion: 'powerflex.run-report.v1',
  generatedAt: new Date().toISOString(),
  scenario: data.name,
  dataProvenance: scenario.dataProvenance,
  objective,
  constraints: {
    facilityPowerCeilingMW: cap,
    maximum15MinuteRampMW: rampLimit,
    workloadScalePercent: 100,
    modelFeasibility: managedConstraints,
    baselineFeasibility: baselineConstraints,
  },
  optimizer: managed.optimizer,
  objectiveScore: { value: Number(managed.objectiveScore.toFixed(8)), interpretation: 'Heuristic tie-break score; it is not a cost, percentage, or optimality certificate.' },
  comparisonOrder: ['minimize hard-constraint event count', 'minimize total cap/ramp excess', 'minimize selected weighted objective score'],
  inputs: {
    facilityBaselineMW: data.facilityBaselineMW,
    carbonIntensityKgPerMWh: data.carbonKgPerMWh,
    electricityPriceUSDPerMWh: data.priceUSDPerMWh,
    jobPowerShape: api.phase,
    jobPowerRampIntervals: api.JOB_POWER_RAMP_INTERVALS,
    jobs: scenario.jobs,
  },
  metrics: {
    baseline: {
      peakMW: api.maxValue(baseline.power),
      max15MinuteRampMW: api.maxRamp(baseline.power),
      energyMWh: baselineTotals.energyMWh,
      costUSD: baselineTotals.costUSD,
      emissionsKgCO2e: baselineTotals.emissionsKg,
      hardConstraints: baselineConstraints,
    },
    powerflex: {
      peakMW: api.maxValue(managed.power),
      max15MinuteRampMW: api.maxRamp(managed.power),
      energyMWh: managedTotals.energyMWh,
      costUSD: managedTotals.costUSD,
      emissionsKgCO2e: managedTotals.emissionsKg,
      jobsOnTime: managed.schedule.filter((job) => job.endSlot <= api.slot(job.deadline)).length,
      hardConstraints: managedConstraints,
    },
  },
  schedules: { earliestStart: toJobs(baseline.schedule), powerflex: toJobs(managed.schedule) },
  timeSeries,
  modelBoundary: 'Measured incremental whole-node profiles and measured node background; one-node 15-minute replay. Deadline slack is synthetic, prices/carbon are omitted, and results are not facility or operational guarantees.',
};
fs.writeFileSync(path.join(here, 'powerflex_real_data_run_report.json'), `${JSON.stringify(runReport, null, 2)}\n`);

const result = {
  schemaVersion: 'powerflex.real-data-optimizer-eval.v1',
  scenario: scenario.name,
  dataProvenance: scenario.dataProvenance,
  settings,
  referenceSchedule: {
    peakPower_kW: Number((api.maxValue(baseline.power) * 1000).toFixed(6)),
    max15MinuteRamp_kW: Number((api.maxRamp(baseline.power) * 1000).toFixed(6)),
    powerCeilingBreaches: baselineConstraints.capIntervals,
    rampBreaches: baselineConstraints.rampEvents,
  },
  powerflexSchedule: {
    peakPower_kW: Number((api.maxValue(managed.power) * 1000).toFixed(6)),
    max15MinuteRamp_kW: Number((api.maxRamp(managed.power) * 1000).toFixed(6)),
    powerCeilingBreaches: managedConstraints.capIntervals,
    rampBreaches: managedConstraints.rampEvents,
    deadlineMisses: managedConstraints.deadlineMisses,
    energy_kWh: Number((managedTotals.energyMWh * 1000).toFixed(6)),
  },
  comparison: {
    modeledPeakChangePercent: Number((api.pctChange(api.maxValue(baseline.power), api.maxValue(managed.power))).toFixed(4)),
    modeledRampChangePercent: Number((api.pctChange(api.maxRamp(baseline.power), api.maxRamp(managed.power))).toFixed(4)),
    baselineReconstructionRmse_kW: Number((rmseMW * 1000).toFixed(6)),
    baselineReconstructionMethod: 'Observed 15-minute mean minus estimated selected-job profiles; zero RMSE is true by construction and is not independent model-accuracy evidence.',
    maxAbsoluteReconstructionError_kW: Number((Math.max(...reconstructionErrorMW.map(Math.abs)) * 1000).toFixed(6)),
    jobStartChanges: startChanges,
  },
  limits: [
    'One representative Eagle GPU node, not a facility or cluster-wide result.',
    'Power profiles estimate whole-node load above a median idle estimate; the observed-start reference is reconstructed by subtracting those same estimated job profiles, so reconstruction RMSE is zero by construction and not independent model validation.',
    'Deadline windows add up to 60 minutes after observed completion and are synthetic; source records have no contractual deadlines.',
    'Data-derived ceiling and ramp thresholds are evaluation thresholds, not engineering operating limits.',
    'The source contains no time-varying electricity-price or carbon-intensity profiles; those objectives are disabled.',
    'Only 3 completed, single-node GPU jobs are matched in the selected day; this is a smoke-scale case study, not statistical evidence.',
  ],
};
fs.writeFileSync(path.join(here, 'optimizer_evaluation.json'), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
