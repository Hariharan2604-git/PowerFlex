// Offline shadow comparison using the scheduler code embedded in ../index.html.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appPath = path.resolve(here, '..', 'index.html');
const inputsPath = path.join(here, 'broad', 'broad_trace_inputs.json');
const outputPath = path.join(here, 'broad', 'broad_scheduler_results.json');
const html = fs.readFileSync(appPath, 'utf8');
const input = JSON.parse(fs.readFileSync(inputsPath, 'utf8'));
const start = html.indexOf('      const HORIZON = 24;');
const end = html.indexOf('      function runSimulation() {', start);
if (start < 0 || end < 0) throw new Error('Could not locate PowerFlex scheduler functions.');
const harness = `${html.slice(start, end)}\n globalThis.api = { buildBaseline, scheduleJobs, operatingTotals, maxValue, maxRamp, pctChange, slot };`;
const sandbox = { console, Math, Intl, Set, Array, Number, String };
vm.runInNewContext(harness, sandbox, { filename: appPath });
const api = sandbox.api;

const outcomes = [];
for (const scenario of input.cases) {
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
  const cap = Number(scenario.evaluationSettings.powerCeilingMW);
  const rampLimit = Number(scenario.evaluationSettings.maximum15MinuteRampMW);
  const baseline = api.buildBaseline(data);
  const managed = api.scheduleJobs(data, cap, rampLimit, 'carbon', baseline);
  const baselineTotals = api.operatingTotals(baseline.power, data);
  const managedTotals = api.operatingTotals(managed.power, data);
  const baseJob = baseline.schedule[0];
  const managedJob = managed.schedule[0];
  outcomes.push({
    caseId: scenario.caseId,
    utcDate: scenario.windowUtcDate,
    objective: 'carbon-only heuristic with regional estimated EIA intensity; price unavailable',
    baseline: {
      recordedStartHourRounded15m: baseJob.startSlot * api.STEP_HOURS,
      peakPower_kW: api.maxValue(baseline.power) * 1000,
      max15MinuteRamp_kW: api.maxRamp(baseline.power) * 1000,
      nodeEnergy_kWh: baselineTotals.energyMWh * 1000,
      regionalCarbonProxy_kgCO2: baselineTotals.emissionsKg,
    },
    powerflex: {
      scheduledStartHour: managedJob.startSlot * api.STEP_HOURS,
      syntheticLatestFinishHour: managedJob.deadline,
      peakPower_kW: api.maxValue(managed.power) * 1000,
      max15MinuteRamp_kW: api.maxRamp(managed.power) * 1000,
      nodeEnergy_kWh: managedTotals.energyMWh * 1000,
      regionalCarbonProxy_kgCO2: managedTotals.emissionsKg,
      meetsSyntheticLatestFinish: managedJob.endSlot <= api.slot(managedJob.deadline),
      modelConstraintEvents: managed.constraints.totalViolationEvents,
    },
    comparison: {
      scheduledShiftMinutesVsRecorded: (managedJob.startSlot - baseJob.startSlot) * 15,
      addedDelayMinutesVsEarliestRelease: Math.max(0, managedJob.startSlot - api.slot(managedJob.release)) * 15,
      peakChangePercent: api.pctChange(api.maxValue(baseline.power), api.maxValue(managed.power)),
      rampChangePercent: api.pctChange(api.maxRamp(baseline.power), api.maxRamp(managed.power)),
      regionalCarbonProxyChangePercent: api.pctChange(baselineTotals.emissionsKg, managedTotals.emissionsKg),
    },
  });
}

const values = (key) => outcomes.map((row) => row.comparison[key]).filter(Number.isFinite);
const median = (items) => {
  const sorted = [...items].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const mean = (items) => items.length ? items.reduce((sum, value) => sum + value, 0) / items.length : null;
const summary = {
  schemaVersion: 'powerflex.broad-shadow-evaluation.v1',
  scenarioCount: outcomes.length,
  objective: 'carbon-only; EIA-930 hourly estimated average consumption CO2 intensity repeated to 15-minute slots',
  priceSignal: 'unavailable; no price objective or cost claim',
  deadlineStatus: 'Sensitivity-only synthetic latest finish; source has no actual contractual/user deadlines.',
  recordedSchedulerReference: 'Historical Slurm start times rounded to the nearest 15-minute interval',
  metrics: {
    medianPeakChangePercent: median(values('peakChangePercent')),
    medianRampChangePercent: median(values('rampChangePercent')),
    medianRegionalCarbonProxyChangePercent: median(values('regionalCarbonProxyChangePercent')),
    meanRegionalCarbonProxyChangePercent: mean(values('regionalCarbonProxyChangePercent')),
    medianScheduledShiftMinutes: median(values('scheduledShiftMinutesVsRecorded')),
    carbonProxyImprovedCases: outcomes.filter((row) => row.comparison.regionalCarbonProxyChangePercent < -1e-9).length,
    carbonProxyWorsenedCases: outcomes.filter((row) => row.comparison.regionalCarbonProxyChangePercent > 1e-9).length,
    carbonProxyUnchangedCases: outcomes.filter((row) => Math.abs(row.comparison.regionalCarbonProxyChangePercent) <= 1e-9).length,
    syntheticDeadlineMisses: outcomes.filter((row) => !row.powerflex.meetsSyntheticLatestFinish).length,
  },
  methodBoundary: input.evaluationDesign,
  limitations: [
    'One-job-at-a-time counterfactuals on one representative node; other measured activity stays fixed. This is not a full cluster or live scheduler run.',
    'The historical Slurm schedule is the existing-scheduler reference; the PowerFlex heuristic is evaluated offline.',
    'The 60-minute slack used in sensitivity cases is synthetic; real deadline compliance remains unevaluated.',
    'Regional carbon proxy is an EIA estimate and is not site-meter or marginal carbon accounting.',
    'No time-aligned site price was supplied; price savings are not measured.',
    'The per-job increment is estimated from whole-node iLO power above a median idle estimate.',
    'The heuristic does not guarantee a global optimum.',
  ],
  cases: outcomes,
};
fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ scenarioCount: summary.scenarioCount, metrics: summary.metrics, outputPath }, null, 2)}\n`);
