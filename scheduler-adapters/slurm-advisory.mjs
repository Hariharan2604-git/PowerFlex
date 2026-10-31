#!/usr/bin/env node
// Read-only Slurm adapter for PowerFlex. It never submits, updates, holds,
// releases, or cancels jobs. All scheduler data is read locally.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appPath = path.resolve(here, '..', 'index.html');
function usage(exitCode = 0) {
  console.error([
    'PowerFlex Slurm advisory adapter (read-only)',
    '  node slurm-advisory.mjs --snapshot scontrol-jobs.json --signals site-signals.json',
    '      --out advisory.json --mapping-out private-job-map.json',
    '  node slurm-advisory.mjs --live --signals site-signals.json',
    '      --out advisory.json --mapping-out private-job-map.json',
    '      [--force]  (replace existing output files only when explicitly requested)',
    '',
    'Live mode runs only: scontrol show jobs --json',
    'No Slurm mutation command is present in this adapter.'
  ].join('\n'));
  process.exit(exitCode);
}

function parseArgs(argv) {
  const options = { live: false, force: false };
  const valueFlags = new Set(['--snapshot', '--signals', '--out', '--mapping-out']);
  const booleanFlags = new Set(['--live', '--force']);
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') usage(0);
    if (valueFlags.has(flag)) {
      if (Object.prototype.hasOwnProperty.call(options, flag)) throw new Error('Argument supplied more than once: ' + flag);
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error('Missing value for ' + flag);
      options[flag] = value;
      i += 1;
      continue;
    }
    if (booleanFlags.has(flag)) {
      const key = flag.slice(2);
      if (options[key]) throw new Error('Argument supplied more than once: ' + flag);
      options[key] = true;
      continue;
    }
    throw new Error('Unknown argument: ' + flag);
  }
  if ((!options['--snapshot'] && !options.live) || (options['--snapshot'] && options.live) || !options['--signals']) usage(2);
  return {
    snapshotPath: options['--snapshot'],
    signalsPath: options['--signals'],
    outPath: options['--out'] || path.resolve(process.cwd(), 'powerflex-slurm-advisory.json'),
    mappingPath: options['--mapping-out'] || path.resolve(process.cwd(), 'powerflex-slurm-private-map.json'),
    live: options.live,
    force: options.force
  };
}

const cli = parseArgs(process.argv.slice(2));
const { snapshotPath, signalsPath, outPath, mappingPath, live, force } = cli;

function canonicalTarget(file) {
  const resolved = path.resolve(file);
  const parent = fs.realpathSync(path.dirname(resolved));
  const target = path.join(parent, path.basename(resolved));
  try {
    const stats = fs.lstatSync(target);
    if (stats.isSymbolicLink()) throw new Error('Refusing a symbolic-link output path: ' + file);
    if (!stats.isFile()) throw new Error('Output path must be a regular file: ' + file);
    if (!force) throw new Error('Output file already exists; choose a new path or pass --force to replace it: ' + file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return target;
}

const canonicalOutPath = canonicalTarget(outPath);
const canonicalMappingPath = canonicalTarget(mappingPath);
if (canonicalOutPath === canonicalMappingPath) throw new Error('Advisory and private mapping outputs must be different files.');
const inputPaths = [snapshotPath, signalsPath].filter(Boolean).map((file) => fs.realpathSync(file));
if ([canonicalOutPath, canonicalMappingPath].some((target) => inputPaths.includes(target))) {
  throw new Error('Output paths must not overwrite the Slurm snapshot or signals input.');
}

function readJson(file, maxBytes) {
  try {
    const stats = fs.statSync(file);
    if (!stats.isFile() || stats.size > maxBytes) throw new Error('file must be a regular file no larger than ' + maxBytes + ' bytes');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  catch (error) { throw new Error('Cannot read JSON file ' + file + ': ' + error.message); }
}

function writePrivateJson(file, object) {
  const payload = JSON.stringify(object, null, 2) + '\n';
  const tempPath = path.join(path.dirname(file), '.' + path.basename(file) + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp');
  let fd;
  try {
    fd = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(fd, payload, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (force) fs.renameSync(tempPath, file);
    else {
      // Hard-link creation fails if another process created the destination after preflight.
      fs.linkSync(tempPath, file);
      fs.unlinkSync(tempPath);
    }
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tempPath); } catch { /* Best-effort cleanup of the private temporary file. */ }
    throw error;
  }
}

function getSnapshot() {
  if (snapshotPath) return readJson(snapshotPath, 64 * 1024 * 1024);
  // The only live Slurm invocation is a read-only state query.
  const stdout = execFileSync('scontrol', ['show', 'jobs', '--json'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024
  });
  return JSON.parse(stdout);
}

function numeric(value) {
  if (value && typeof value === 'object') {
    if (value.set === false || value.infinite === true) return null;
    if (Number.isFinite(Number(value.number))) return Number(value.number);
    if (Number.isFinite(Number(value.value))) return Number(value.value);
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function timeLimitMinutes(job) {
  const explicit = numeric(job.time_limit_minutes ?? job.timeLimitMinutes ?? job.timelimit_minutes);
  if (explicit !== null && explicit > 0) return explicit;
  const raw = job.time_limit ?? job.timeLimit ?? job.timelimit;
  const n = numeric(raw);
  // Slurm's JSON time_limit is expressed in minutes by current data parsers.
  if (n !== null && n > 0 && n < 100000000) return n;
  const str = String(job.time_limit_str ?? job.timeLimitString ?? raw ?? '');
  const match = /^(?:(\d+)-)?(\d{1,2}):(\d{2}):(\d{2})$/.exec(str);
  if (!match) return null;
  return (((Number(match[1] || 0) * 24 + Number(match[2])) * 60 + Number(match[3])) * 60 + Number(match[4])) / 60;
}

function parseTime(value) {
  if (value === undefined || value === null || value === '' || value === 'Unknown' || value === 'N/A') return null;
  if (typeof value === 'object') value = value.number ?? value.value ?? value.timestamp ?? null;
  if (typeof value === 'number' || /^\d+(\.\d+)?$/.test(String(value))) {
    const n = Number(value);
    // Slurm epoch timestamps are seconds; accept milliseconds for normalized feeds.
    const date = new Date(n < 1e12 ? n * 1000 : n);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  // A timestamp without an explicit timezone must never inherit the host's local zone.
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function requireNumberArray(object, key, length, maxValue) {
  const values = object[key];
  if (!Array.isArray(values) || values.length !== length || values.some((x) => typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > maxValue)) {
    throw new Error(key + ' must be an array of ' + length + ' finite non-negative values no greater than ' + maxValue + '.');
  }
  return [...values];
}

function boundarySlot(date, horizonStart, label, mode) {
  const deltaMs = date.getTime() - horizonStart.getTime();
  const slots = deltaMs / (15 * 60 * 1000);
  if (mode === 'ceil') return Math.ceil(slots - 1e-10);
  if (mode === 'floor') return Math.floor(slots + 1e-10);
  throw new Error('Unknown interval-boundary rounding mode.');
}

function isoAtSlot(start, slot) {
  return new Date(start.getTime() + slot * 15 * 60 * 1000).toISOString();
}

const snapshot = getSnapshot();
const signals = readJson(signalsPath, 1024 * 1024);
if (!signals || signals.schemaVersion !== 'powerflex.slurm-advisory-signals.v1') {
  throw new Error('Signals file must use schemaVersion powerflex.slurm-advisory-signals.v1.');
}
if (signals.intervalMinutes !== 15 || signals.horizonHours !== 24) {
  throw new Error('Signals must cover a 24-hour horizon at 15-minute intervals.');
}
if (typeof signals.horizonStartUtc !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(signals.horizonStartUtc)) {
  throw new Error('horizonStartUtc must be an ISO-8601 UTC timestamp ending in Z.');
}
const horizonStart = parseTime(signals.horizonStartUtc);
if (!horizonStart) throw new Error('Provide horizonStartUtc as an explicit UTC timestamp.');
if (horizonStart.getUTCSeconds() !== 0 || horizonStart.getUTCMilliseconds() !== 0 || horizonStart.getUTCMinutes() % 15 !== 0) {
  throw new Error('horizonStartUtc must be rounded up to a 15-minute UTC boundary.');
}
if (live) {
  const nextQuarterMs = Math.ceil(Date.now() / (15 * 60 * 1000)) * (15 * 60 * 1000);
  if (horizonStart.getTime() < nextQuarterMs) throw new Error('Live mode requires signals beginning at the next UTC quarter-hour or later.');
}
const baselineKW = requireNumberArray(signals, 'facilityBaselineKW', 96, 10000000);
const priceRaw = signals.electricityPriceUSDPerMWh;
if (!Array.isArray(priceRaw) || priceRaw.length !== 96 || priceRaw.some((x) => typeof x !== 'number' || !Number.isFinite(x) || Math.abs(x) > 1000000)) {
  throw new Error('electricityPriceUSDPerMWh must contain 96 finite values between -1000000 and 1000000 USD/MWh.');
}
const price = [...priceRaw];
const carbon = requireNumberArray(signals, 'carbonIntensityKgPerMWh', 96, 1000000);
const powerCeilingKW = signals.powerCeilingKW;
const rampLimitKW = signals.maximum15MinuteRampKW;
if (typeof powerCeilingKW !== 'number' || !(powerCeilingKW > 0 && powerCeilingKW <= 10000000) || typeof rampLimitKW !== 'number' || !(rampLimitKW > 0 && rampLimitKW <= 10000000)) {
  throw new Error('Supply positive numeric powerCeilingKW and maximum15MinuteRampKW constraints no greater than 10000000 kW.');
}
if (!['balanced', 'cost', 'carbon', 'lowcarbon', 'stability'].includes(signals.objective || 'balanced')) {
  throw new Error('objective must be balanced, cost, carbon, lowcarbon, or stability.');
}
for (const [key, label] of [['powerProvenance', 'power'], ['priceProvenance', 'electricity price'], ['carbonProvenance', 'carbon']]) {
  if (typeof signals[key] !== 'string' || signals[key].trim().length < 3 || signals[key].length > 500 || /[\u0000-\u001f\u007f]/.test(signals[key])) {
    throw new Error('Supply a concise, non-empty ' + label + ' provenance field (maximum 500 characters).');
  }
}
if (signals.jobEstimates !== undefined && (!signals.jobEstimates || typeof signals.jobEstimates !== 'object' || Array.isArray(signals.jobEstimates))) {
  throw new Error('jobEstimates must be a JSON object keyed by Slurm job ID.');
}
if (signals.dueTimeUtcByJobId !== undefined && (!signals.dueTimeUtcByJobId || typeof signals.dueTimeUtcByJobId !== 'object' || Array.isArray(signals.dueTimeUtcByJobId))) {
  throw new Error('dueTimeUtcByJobId must be a JSON object keyed by Slurm job ID.');
}
const estimates = signals.jobEstimates || {};
const jobsRaw = snapshot.jobs || snapshot.job || snapshot;
if (!Array.isArray(jobsRaw)) throw new Error('Slurm snapshot must contain a jobs array.');
const dueById = signals.dueTimeUtcByJobId || {};
const blockers = [];
const mapping = {};
const jobs = [];
let pendingSequence = 0;
const horizonEnd = new Date(horizonStart.getTime() + 24 * 60 * 60 * 1000);
const allStates = new Set(['PENDING', 'PD', 'PENDING+']);
const seenJobIds = new Set();

for (const row of jobsRaw) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Slurm snapshot jobs must be JSON objects.');
  const state = String(row.job_state ?? row.jobState ?? row.state ?? '').toUpperCase();
  if (!allStates.has(state)) continue;
  const slurmId = String(row.job_id ?? row.jobId ?? row.job_id_raw ?? row.id ?? '');
  if (!/^\d+(?:_\d+)?(?:\+\d+)?$/.test(slurmId)) { blockers.push({ reason: 'pending job omitted: snapshot has a missing or unsupported Slurm job ID' }); continue; }
  if (seenJobIds.has(slurmId)) throw new Error('Slurm snapshot contains a duplicate pending job ID; refusing an ambiguous advisory.');
  seenJobIds.add(slurmId);
  pendingSequence += 1;
  const alias = 'JOB-' + String(pendingSequence).padStart(3, '0');
  const estimate = Object.prototype.hasOwnProperty.call(estimates, slurmId) ? estimates[slurmId] : {};
  const suppliedDue = Object.prototype.hasOwnProperty.call(dueById, slurmId) ? dueById[slurmId] : undefined;
  const due = parseTime(suppliedDue ?? row.deadline ?? row.deadline_time ?? row.deadlineTime);
  const submit = parseTime(row.submit_time ?? row.submitTime ?? row.Submit);
  const eligible = parseTime(row.eligible_time ?? row.eligibleTime ?? row.EligibleTime);
  const releaseTime = eligible || submit;
  if (!estimate || typeof estimate !== 'object' || Array.isArray(estimate)) {
    blockers.push({ jobAlias: alias, reason: 'job estimate is not a JSON object' }); continue;
  }
  const durationMinutes = estimate.estimatedDurationMinutes;
  const limit = timeLimitMinutes(row);
  const powerProfileKW = estimate.powerProfileKW;

  if (!due) { blockers.push({ jobAlias: alias, reason: 'no actual Slurm deadline or supplied authorized due time' }); continue; }
  if (!releaseTime) { blockers.push({ jobAlias: alias, reason: 'missing submit/eligible timestamp' }); continue; }
  if (due <= horizonStart || due > horizonEnd) { blockers.push({ jobAlias: alias, reason: 'deadline is outside the next-24-hour planning horizon' }); continue; }
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0 || durationMinutes % 15 !== 0) {
    blockers.push({ jobAlias: alias, reason: 'missing 15-minute-aligned runtime forecast; Slurm wallclock limit is not treated as a runtime forecast' }); continue;
  }
  if (limit !== null && durationMinutes > limit) { blockers.push({ jobAlias: alias, reason: 'runtime forecast exceeds the Slurm wallclock limit' }); continue; }
  const durationSlots = durationMinutes / 15;
  if (!Array.isArray(powerProfileKW) || powerProfileKW.length !== durationSlots || powerProfileKW.some((x) => typeof x !== 'number' || !Number.isFinite(x) || x <= 0 || x > 100000)) {
    blockers.push({ jobAlias: alias, reason: 'missing measured or validated per-job power profile in kW' }); continue;
  }
  // Round releases up and due times down so the 15-minute model stays
  // conservative around real timestamps that include seconds.
  const release = Math.max(0, boundarySlot(releaseTime, horizonStart, 'Slurm eligible time', 'ceil'));
  const deadline = boundarySlot(due, horizonStart, 'job due time', 'floor');
  const duration = durationMinutes / 60;
  if (release + durationSlots > deadline) { blockers.push({ jobAlias: alias, reason: 'runtime cannot fit between release and due time' }); continue; }
  const baselineStartDate = estimate.baselineStartUtc === undefined ? releaseTime : parseTime(estimate.baselineStartUtc);
  if (!baselineStartDate) { blockers.push({ jobAlias: alias, reason: 'supplied baselineStartUtc is invalid or lacks a timezone' }); continue; }
  const baselineStart = Math.max(release, boundarySlot(baselineStartDate, horizonStart, 'baseline start', 'ceil'));
  if (baselineStart + durationSlots > deadline) { blockers.push({ jobAlias: alias, reason: 'baseline start and runtime exceed actual due time' }); continue; }
  mapping[alias] = { slurmJobId: slurmId };
  jobs.push({
    id: alias,
    release: release / 4,
    deadline: deadline / 4,
    duration,
    peak: Math.max(...powerProfileKW) / 1000,
    phaseOffset: 0,
    baselineStart: baselineStart / 4,
    powerProfileMW: powerProfileKW.map((x) => x / 1000),
    metadata: { wallclockLimitMinutes: limit, runtimeForecastMinutes: durationMinutes }
  });
}

if (!jobs.length) {
  const report = {
    schemaVersion: 'powerflex.slurm-advisory.v1', mode: 'advisory-only',
    generatedAtUtc: new Date().toISOString(), horizonStartUtc: horizonStart.toISOString(),
    status: 'no-recommendation', reason: 'No pending job has all required deadline, runtime, power, and signal inputs.',
    pendingJobsSeen: jobsRaw.filter((j) => allStates.has(String(j.job_state ?? j.jobState ?? j.state ?? '').toUpperCase())).length,
    recommendedJobs: [], blockers, safety: { schedulerMutationsPerformed: false, schedulerCommandsUsed: live ? ['scontrol show jobs --json'] : [], runningJobsChanged: false }
  };
  writePrivateJson(canonicalOutPath, report);
  writePrivateJson(canonicalMappingPath, { generatedAtUtc: report.generatedAtUtc, localOnly: true, mapping });
  console.log(JSON.stringify({ status: report.status, blockers: blockers.length, outPath }, null, 2));
  process.exit(0);
}
if (jobs.length > 50) throw new Error('The PowerFlex prototype supports at most 50 eligible jobs per planning horizon.');

const start = appPath;
const html = fs.readFileSync(appPath, 'utf8');
const solverStart = html.indexOf('      const HORIZON = 24;');
const solverEnd = html.indexOf('      function runSimulation() {', solverStart);
if (solverStart < 0 || solverEnd < 0) throw new Error('Could not locate the current PowerFlex solver in index.html.');
const sandbox = { console, Math, Intl, Set, WeakMap, Array, Number, String };
const solverContext = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
// This executes the repository-owned solver excerpt. JSON inputs stay data and
// are never interpolated into or evaluated as JavaScript source.
vm.runInContext(html.slice(solverStart, solverEnd) + '\n globalThis.api = { buildBaseline, scheduleJobs, operatingTotals, constraintMetrics, maxValue, maxRamp };', solverContext, { filename: start, timeout: 10000 });
const api = sandbox.api;
const scenario = {
  facilityBaselineMW: baselineKW.map((x) => x / 1000),
  priceUSDPerMWh: price,
  carbonKgPerMWh: carbon,
  jobs
};
// A constant price offset leaves the ordering of fixed-energy schedules
// unchanged and lets the heuristic handle negative wholesale prices safely.
const priceOffset = Math.max(0, -Math.min(...price));
const solverScenario = { ...scenario, priceUSDPerMWh: price.map((x) => x + priceOffset) };
const capMW = powerCeilingKW / 1000;
const rampMW = rampLimitKW / 1000;
const baseline = api.buildBaseline(scenario);
const managed = api.scheduleJobs(solverScenario, capMW, rampMW, signals.objective || 'balanced', baseline);
const baseTotals = api.operatingTotals(baseline.power, scenario);
const optimizedTotals = api.operatingTotals(managed.power, scenario);
const recommendations = managed.schedule.map((job) => {
  const before = baseline.schedule.find((candidate) => candidate.id === job.id);
  const deltaSlots = job.startSlot - before.startSlot;
  return {
    jobAlias: job.id,
    baselineStartUtc: isoAtSlot(horizonStart, before.startSlot),
    recommendedStartUtc: isoAtSlot(horizonStart, job.startSlot),
    completionUtc: isoAtSlot(horizonStart, job.endSlot),
    moveMinutes: deltaSlots * 15,
    completionMeetsActualDueTime: job.endSlot <= boundarySlot(new Date(horizonStart.getTime() + job.deadline * 60 * 60 * 1000), horizonStart, 'due time', 'floor'),
    meetsSlurmWallclockLimit: job.metadata.wallclockLimitMinutes === null || job.metadata.runtimeForecastMinutes <= job.metadata.wallclockLimitMinutes
  };
});
const report = {
  schemaVersion: 'powerflex.slurm-advisory.v1',
  mode: 'advisory-only',
  generatedAtUtc: new Date().toISOString(),
  horizonStartUtc: horizonStart.toISOString(),
  objective: signals.objective || 'balanced',
  status: managed.constraints.feasible ? 'recommendations-ready' : 'best-effort-with-constraint-breaches',
  signals: {
    electricityPrice: signals.priceProvenance,
    carbon: signals.carbonProvenance,
    power: signals.powerProvenance,
    intervalMinutes: 15,
    timezone: 'UTC',
    allProfilesHave96Intervals: true,
    provenanceIndependentlyVerified: false
  },
  constraints: {
    powerCeilingKW, maximum15MinuteRampKW: rampLimitKW,
    actualDueTimeSource: 'Slurm deadline field or operator-supplied dueTimeUtcByJobId; synthetic deadlines are rejected',
    runtimeSource: 'operator-supplied runtime forecast, checked against the Slurm wallclock limit',
    solverConstraintSummary: managed.constraints,
    allDueTimesMet: recommendations.every((x) => x.completionMeetsActualDueTime),
    allWallclockLimitsMet: recommendations.every((x) => x.meetsSlurmWallclockLimit)
  },
  comparison: {
    baselineCostUSD: baseTotals.costUSD,
    advisoryCostUSD: optimizedTotals.costUSD,
    costChangeUSD: optimizedTotals.costUSD - baseTotals.costUSD,
    baselineCarbonKg: baseTotals.emissionsKg,
    advisoryCarbonKg: optimizedTotals.emissionsKg,
    carbonChangeKg: optimizedTotals.emissionsKg - baseTotals.emissionsKg,
    baselinePeakKW: api.maxValue(baseline.power) * 1000,
    advisoryPeakKW: api.maxValue(managed.power) * 1000,
    baselineMax15MinuteRampKW: api.maxRamp(baseline.power) * 1000,
    advisoryMax15MinuteRampKW: api.maxRamp(managed.power) * 1000,
    solverPriceOffsetUSDPerMWh: priceOffset,
    heuristicOptimality: 'not guaranteed; deterministic multi-start coordinate search'
  },
  recommendedJobs: recommendations,
  blockedJobs: blockers,
  safety: {
    schedulerMutationsPerformed: false,
    schedulerCommandsUsed: live ? ['scontrol show jobs --json'] : [],
    runningJobsChanged: false,
    jobNamesAccountsUsersAndPathsEmitted: false,
    privateMappingFileWritten: true,
    keepMappingFileLocal: true
  }
};

writePrivateJson(canonicalOutPath, report);
writePrivateJson(canonicalMappingPath, { generatedAtUtc: report.generatedAtUtc, localOnly: true, mapping });
console.log(JSON.stringify({ status: report.status, eligibleJobs: jobs.length, blockedJobs: blockers.length, costChangeUSD: report.comparison.costChangeUSD, carbonChangeKg: report.comparison.carbonChangeKg, outPath, mappingPath }, null, 2));
