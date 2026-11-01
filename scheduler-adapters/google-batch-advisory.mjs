#!/usr/bin/env node
// Read-only Google Cloud Batch adapter for PowerFlex. It lists jobs only;
// it never creates, cancels, deletes, updates, or otherwise schedules jobs.
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
    'PowerFlex Google Cloud Batch advisory adapter (read-only)',
    '  node google-batch-advisory.mjs --project PROJECT_ID --location REGION',
    '      --profiles batch-profiles.json --signals site-signals.json',
    '      [--snapshot batch-jobs.json] [--out advisory.json]',
    '      [--mapping-out private-batch-map.json] [--force]',
    '',
    'Without --snapshot, lists Cloud Batch jobs using local Application Default Credentials.',
    'The only Batch API method called is projects.locations.jobs.list.'
  ].join('\n'));
  process.exit(exitCode);
}

function parseArgs(argv) {
  const values = new Set(['--project', '--location', '--profiles', '--signals', '--snapshot', '--out', '--mapping-out']);
  const booleans = new Set(['--force']);
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') usage(0);
    if (values.has(flag)) {
      if (Object.prototype.hasOwnProperty.call(options, flag)) throw new Error('Argument supplied more than once: ' + flag);
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error('Missing value for ' + flag);
      options[flag] = value;
      i += 1;
    } else if (booleans.has(flag)) {
      if (options.force) throw new Error('Argument supplied more than once: ' + flag);
      options.force = true;
    } else {
      throw new Error('Unknown argument: ' + flag);
    }
  }
  for (const required of ['--project', '--location', '--profiles', '--signals']) {
    if (!options[required]) throw new Error('Missing required argument: ' + required);
  }
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(options['--project'])) {
    throw new Error('--project must be a Google Cloud project ID (6–30 lowercase letters, digits, or hyphens; beginning with a letter).');
  }
  if (!/^[a-z]+(?:-[a-z0-9]+)+$/.test(options['--location'])) {
    throw new Error('--location must be a Cloud Batch region such as us-central1.');
  }
  return {
    projectId: options['--project'],
    location: options['--location'],
    profilesPath: options['--profiles'],
    signalsPath: options['--signals'],
    snapshotPath: options['--snapshot'],
    outPath: options['--out'] || path.resolve(process.cwd(), 'powerflex-google-batch-advisory.json'),
    mappingPath: options['--mapping-out'] || path.resolve(process.cwd(), 'powerflex-google-batch-private-map.json'),
    force: options.force === true
  };
}

const cli = parseArgs(process.argv.slice(2));

function canonicalTarget(file) {
  const resolved = path.resolve(file);
  const parent = fs.realpathSync(path.dirname(resolved));
  const target = path.join(parent, path.basename(resolved));
  try {
    const stats = fs.lstatSync(target);
    if (stats.isSymbolicLink()) throw new Error('Refusing a symbolic-link output path: ' + file);
    if (!stats.isFile()) throw new Error('Output path must be a regular file: ' + file);
    if (!cli.force) throw new Error('Output file already exists; choose a new path or pass --force to replace it: ' + file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return target;
}

function readJson(file, maxBytes) {
  try {
    const stats = fs.statSync(file);
    if (!stats.isFile() || stats.size > maxBytes) throw new Error('file must be a regular file no larger than ' + maxBytes + ' bytes');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error('Cannot read JSON file ' + file + ': ' + error.message);
  }
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
    if (cli.force) fs.renameSync(tempPath, file);
    else {
      fs.linkSync(tempPath, file);
      fs.unlinkSync(tempPath);
    }
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tempPath); } catch { /* Best-effort cleanup of the private temporary file. */ }
    throw error;
  }
}

const outPath = canonicalTarget(cli.outPath);
const mappingPath = canonicalTarget(cli.mappingPath);
if (outPath === mappingPath) throw new Error('Advisory and private mapping outputs must be different files.');
const inputPaths = [cli.profilesPath, cli.signalsPath, cli.snapshotPath].filter(Boolean).map((file) => fs.realpathSync(file));
if ([outPath, mappingPath].some((target) => inputPaths.includes(target))) {
  throw new Error('Output paths must not overwrite a profiles, signals, or snapshot input.');
}

function parseTimestamp(value) {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function boundarySlot(date, horizonStart, mode) {
  const slots = (date.getTime() - horizonStart.getTime()) / (15 * 60 * 1000);
  if (mode === 'ceil') return Math.ceil(slots - 1e-10);
  if (mode === 'floor') return Math.floor(slots + 1e-10);
  throw new Error('Unknown 15-minute boundary rounding mode.');
}

function isoAtSlot(start, slot) {
  return new Date(start.getTime() + slot * 15 * 60 * 1000).toISOString();
}

function requireNumberArray(object, key, length, maxValue, allowNegative = false) {
  const values = object[key];
  if (!Array.isArray(values) || values.length !== length || values.some((x) => typeof x !== 'number' || !Number.isFinite(x) || (!allowNegative && x < 0) || Math.abs(x) > maxValue)) {
    throw new Error(key + ' must contain ' + length + ' finite numeric values within the documented range.');
  }
  return [...values];
}

function getSnapshot() {
  if (cli.snapshotPath) {
    const snapshot = readJson(cli.snapshotPath, 64 * 1024 * 1024);
    if (Array.isArray(snapshot)) return snapshot;
    if (snapshot && Array.isArray(snapshot.jobs)) return snapshot.jobs;
    throw new Error('Batch snapshot must be an array of Job resources or an object with a jobs array.');
  }

  let token;
  try {
    token = execFileSync('gcloud', ['auth', 'application-default', 'print-access-token'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32768
    }).trim();
  } catch {
    throw new Error('Could not obtain Application Default Credentials. Install/configure gcloud and run `gcloud auth application-default login`; never paste a token or service-account key into this project.');
  }
  if (!token || /\s/.test(token)) throw new Error('gcloud returned no usable Application Default Credentials token.');

  return (async () => {
    const jobs = [];
    let pageToken;
    let pages = 0;
    let responseChars = 0;
    do {
      const params = new URLSearchParams({ pageSize: '200' });
      if (pageToken) params.set('pageToken', pageToken);
      const url = `https://batch.googleapis.com/v1/projects/${encodeURIComponent(cli.projectId)}/locations/${encodeURIComponent(cli.location)}/jobs?${params}`;
      let response;
      try {
        response = await fetch(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(20000)
        });
      } catch (error) {
        throw new Error('Cloud Batch list request failed: ' + error.message);
      }
      if (!response.ok) {
        const status = response.status;
        if (status === 401 || status === 403) throw new Error(`Cloud Batch returned HTTP ${status}. Check that the Batch API is enabled and this identity has Batch Job Viewer access (roles/batch.jobsViewer).`);
        throw new Error(`Cloud Batch list request failed with HTTP ${status}; response details are suppressed to avoid printing project data.`);
      }
      const pageText = await response.text();
      responseChars += pageText.length;
      if (pageText.length > 8 * 1024 * 1024 || responseChars > 64 * 1024 * 1024) {
        throw new Error('Cloud Batch response exceeded the 8 MiB per-page or 64 MiB total safety limit. Use a narrower project or region.');
      }
      let body;
      try { body = JSON.parse(pageText); }
      catch { throw new Error('Cloud Batch returned a response that was not valid JSON.'); }
      if (!body || !Array.isArray(body.jobs)) throw new Error('Cloud Batch returned a response without a jobs array.');
      jobs.push(...body.jobs);
      if (jobs.length > 10000) throw new Error('The live list exceeded the 10,000-job safety limit; use a narrower project or region.');
      pageToken = body.nextPageToken || undefined;
      pages += 1;
      if (pages > 100) throw new Error('Cloud Batch pagination exceeded the 100-page safety limit.');
    } while (pageToken);
    return jobs;
  })();
}

function run() {
  const profiles = readJson(cli.profilesPath, 4 * 1024 * 1024);
  const signals = readJson(cli.signalsPath, 1024 * 1024);
  const snapshotResult = getSnapshot();
  return Promise.resolve(snapshotResult).then((batchJobs) => {
    if (!profiles || profiles.schemaVersion !== 'powerflex.google-batch-profiles.v1' || !profiles.jobs || typeof profiles.jobs !== 'object' || Array.isArray(profiles.jobs)) {
      throw new Error('Profiles file must use schemaVersion powerflex.google-batch-profiles.v1 and have a jobs object keyed by Cloud Batch job ID.');
    }
    if (!signals || signals.schemaVersion !== 'powerflex.google-batch-signals.v1' || signals.intervalMinutes !== 15 || signals.horizonHours !== 24) {
      throw new Error('Signals file must use schemaVersion powerflex.google-batch-signals.v1 for a 24-hour horizon at 15-minute intervals.');
    }
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(signals.horizonStartUtc || '')) {
      throw new Error('horizonStartUtc must be an ISO-8601 UTC timestamp ending in Z.');
    }
    const horizonStart = parseTimestamp(signals.horizonStartUtc);
    if (!horizonStart || horizonStart.getUTCSeconds() !== 0 || horizonStart.getUTCMilliseconds() !== 0 || horizonStart.getUTCMinutes() % 15 !== 0) {
      throw new Error('horizonStartUtc must be rounded to a 15-minute UTC boundary.');
    }
    if (!cli.snapshotPath) {
      const nextQuarterMs = Math.ceil(Date.now() / (15 * 60 * 1000)) * (15 * 60 * 1000);
      if (horizonStart.getTime() < nextQuarterMs) throw new Error('Live mode requires signals beginning at the next UTC quarter-hour or later.');
    }
    const baselineKW = requireNumberArray(signals, 'facilityBaselineKW', 96, 10000000);
    const price = requireNumberArray(signals, 'electricityPriceUSDPerMWh', 96, 1000000, true);
    const carbon = requireNumberArray(signals, 'carbonIntensityKgPerMWh', 96, 1000000);
    if (typeof signals.powerCeilingKW !== 'number' || !(signals.powerCeilingKW > 0 && signals.powerCeilingKW <= 10000000) || typeof signals.maximum15MinuteRampKW !== 'number' || !(signals.maximum15MinuteRampKW > 0 && signals.maximum15MinuteRampKW <= 10000000)) {
      throw new Error('Supply positive numeric powerCeilingKW and maximum15MinuteRampKW.');
    }
    if (!['balanced', 'cost', 'carbon', 'lowcarbon', 'stability'].includes(signals.objective || 'balanced')) {
      throw new Error('objective must be balanced, cost, carbon, lowcarbon, or stability.');
    }
    for (const [key, label] of [['powerProvenance', 'power'], ['priceProvenance', 'electricity price'], ['carbonProvenance', 'carbon']]) {
      if (typeof signals[key] !== 'string' || signals[key].trim().length < 3 || signals[key].length > 500 || /[\u0000-\u001f\u007f]/.test(signals[key])) {
        throw new Error('Supply a concise, non-empty ' + label + ' provenance field (maximum 500 characters).');
      }
    }
    if (!Array.isArray(batchJobs)) throw new Error('Batch response must be an array.');

    const blockers = [];
    const aliases = {};
    const solverJobs = [];
    const queued = batchJobs.filter((row) => row?.status?.state === 'QUEUED');
    const scheduledIgnored = batchJobs.filter((row) => row?.status?.state === 'SCHEDULED').length;
    const horizonEnd = new Date(horizonStart.getTime() + 24 * 60 * 60 * 1000);
    let pendingSequence = 0;

    for (const row of queued) {
      const match = typeof row.name === 'string' && /\/jobs\/([^/]+)$/.exec(row.name);
      if (!match) { blockers.push({ reason: 'queued job omitted: Cloud Batch resource name is missing or invalid' }); continue; }
      const jobId = match[1];
      pendingSequence += 1;
      const alias = 'JOB-' + String(pendingSequence).padStart(3, '0');
      const profile = Object.prototype.hasOwnProperty.call(profiles.jobs, jobId) ? profiles.jobs[jobId] : undefined;
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
        blockers.push({ jobAlias: alias, reason: 'no operator-supplied deadline, runtime forecast, and validated power profile for this job' });
        continue;
      }
      const taskGroups = Array.isArray(row.taskGroups) ? row.taskGroups : [];
      if (taskGroups.length !== 1) { blockers.push({ jobAlias: alias, reason: 'prototype supports exactly one Cloud Batch task group per modeled job' }); continue; }
      const group = taskGroups[0];
      const taskCount = Number(group.taskCount ?? 1);
      if (taskCount !== 1) { blockers.push({ jobAlias: alias, reason: 'prototype supports single-task Cloud Batch jobs; aggregated parallel task groups are not modeled' }); continue; }

      const created = parseTimestamp(row.createTime);
      const releaseTime = profile.releaseUtc === undefined ? created : parseTimestamp(profile.releaseUtc);
      const due = parseTimestamp(profile.deadlineUtc);
      if (!due) { blockers.push({ jobAlias: alias, reason: 'missing actual completion deadline in the local profile file' }); continue; }
      if (!releaseTime) { blockers.push({ jobAlias: alias, reason: 'missing Cloud Batch createTime or valid operator-supplied releaseUtc' }); continue; }
      if (due <= horizonStart || due > horizonEnd) { blockers.push({ jobAlias: alias, reason: 'deadline is outside the 24-hour planning horizon' }); continue; }

      const durationMinutes = profile.estimatedDurationMinutes;
      if (!Number.isFinite(durationMinutes) || durationMinutes <= 0 || durationMinutes % 15 !== 0) {
        blockers.push({ jobAlias: alias, reason: 'runtime forecast must be a positive multiple of 15 minutes; Batch maxRunDuration is not used as a forecast' }); continue;
      }
      const maxRunDuration = group.taskSpec?.maxRunDuration;
      let maxRunMinutes = null;
      if (maxRunDuration !== undefined) {
        const durationMatch = /^(\d+(?:\.\d+)?)s$/.exec(String(maxRunDuration));
        if (!durationMatch) { blockers.push({ jobAlias: alias, reason: 'Cloud Batch maxRunDuration has an unsupported format' }); continue; }
        maxRunMinutes = Number(durationMatch[1]) / 60;
        if (durationMinutes > maxRunMinutes) { blockers.push({ jobAlias: alias, reason: 'runtime forecast exceeds the configured Cloud Batch maxRunDuration' }); continue; }
      }
      const durationSlots = durationMinutes / 15;
      const powerProfileKW = profile.powerProfileKW;
      if (!Array.isArray(powerProfileKW) || powerProfileKW.length !== durationSlots || powerProfileKW.some((x) => typeof x !== 'number' || !Number.isFinite(x) || x <= 0 || x > 100000)) {
        blockers.push({ jobAlias: alias, reason: 'powerProfileKW must contain one validated kW value per 15-minute runtime interval' }); continue;
      }
      const release = Math.max(0, boundarySlot(releaseTime, horizonStart, 'ceil'));
      const deadline = boundarySlot(due, horizonStart, 'floor');
      if (release + durationSlots > deadline) { blockers.push({ jobAlias: alias, reason: 'runtime cannot fit between release and deadline' }); continue; }

      const baselineDate = profile.baselineStartUtc === undefined ? releaseTime : parseTimestamp(profile.baselineStartUtc);
      if (!baselineDate) { blockers.push({ jobAlias: alias, reason: 'baselineStartUtc must be a timestamp with an explicit time zone' }); continue; }
      const baselineStart = Math.max(release, boundarySlot(baselineDate, horizonStart, 'ceil'));
      if (baselineStart + durationSlots > deadline) { blockers.push({ jobAlias: alias, reason: 'baseline start and runtime exceed the supplied completion deadline' }); continue; }

      aliases[alias] = { batchJobResourceName: row.name };
      solverJobs.push({
        id: alias,
        release: release / 4,
        deadline: deadline / 4,
        duration: durationMinutes / 60,
        peak: Math.max(...powerProfileKW) / 1000,
        phaseOffset: 0,
        baselineStart: baselineStart / 4,
        powerProfileMW: powerProfileKW.map((x) => x / 1000),
        metadata: { cloudBatchMaxRunDurationMinutes: maxRunMinutes, runtimeForecastMinutes: durationMinutes }
      });
    }

    const mapping = {
      generatedAtUtc: new Date().toISOString(),
      localOnly: true,
      projectId: cli.projectId,
      location: cli.location,
      aliasToBatchJobResourceName: aliases
    };
    const generatedAtUtc = mapping.generatedAtUtc;
    const reportBase = {
      schemaVersion: 'powerflex.google-batch-advisory.v1',
      mode: 'advisory-only',
      integration: 'Google Cloud Batch v1 REST API',
      inputMode: cli.snapshotPath ? 'saved-snapshot' : 'live-authenticated-list',
      generatedAtUtc,
      horizonStartUtc: horizonStart.toISOString(),
      objective: signals.objective || 'balanced',
      pendingJobsSeen: queued.length,
      scheduledJobsIgnored: scheduledIgnored,
      signals: {
        power: signals.powerProvenance,
        electricityPrice: signals.priceProvenance,
        carbon: signals.carbonProvenance,
        intervalMinutes: 15,
        timezone: 'UTC',
        provenanceIndependentlyVerified: false
      },
      safety: {
        schedulerMutationsPerformed: false,
        batchApiMethodsUsed: cli.snapshotPath ? [] : ['projects.locations.jobs.list'],
        jobNamesAndResourcePathsEmitted: false,
        privateMappingFileWritten: true,
        keepMappingFileLocal: true
      }
    };

    if (solverJobs.length > 50) throw new Error('PowerFlex supports at most 50 eligible jobs per planning horizon.');
    if (!solverJobs.length) {
      const report = {
        ...reportBase,
        status: 'no-recommendation',
        reason: 'No queued Cloud Batch job has the required deadline, runtime, power profile, and signal inputs.',
        recommendedJobs: [],
        blockedJobs: blockers
      };
      writePrivateJson(outPath, report);
      writePrivateJson(mappingPath, mapping);
      console.log(JSON.stringify({ status: report.status, queuedJobs: queued.length, blockers: blockers.length, outPath }, null, 2));
      return;
    }

    const html = fs.readFileSync(appPath, 'utf8');
    const solverStart = html.indexOf('      const HORIZON = 24;');
    const solverEnd = html.indexOf('      function runSimulation() {', solverStart);
    if (solverStart < 0 || solverEnd < 0) throw new Error('Could not locate the current PowerFlex solver in index.html.');
    const sandbox = { console, Math, Intl, Set, WeakMap, Array, Number, String };
    const solverContext = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    vm.runInContext(html.slice(solverStart, solverEnd) + '\n globalThis.api = { buildBaseline, scheduleJobs, operatingTotals, maxValue, maxRamp };', solverContext, { filename: appPath, timeout: 10000 });
    const api = sandbox.api;
    const scenario = {
      facilityBaselineMW: baselineKW.map((x) => x / 1000),
      priceUSDPerMWh: price,
      carbonKgPerMWh: carbon,
      jobs: solverJobs
    };
    const priceOffset = Math.max(0, -Math.min(...price));
    const solverScenario = { ...scenario, priceUSDPerMWh: price.map((x) => x + priceOffset) };
    const capMW = signals.powerCeilingKW / 1000;
    const rampMW = signals.maximum15MinuteRampKW / 1000;
    const baseline = api.buildBaseline(scenario);
    const managed = api.scheduleJobs(solverScenario, capMW, rampMW, signals.objective || 'balanced', baseline);
    const baseTotals = api.operatingTotals(baseline.power, scenario);
    const optimizedTotals = api.operatingTotals(managed.power, scenario);
    const recommendations = managed.schedule.map((job) => {
      const before = baseline.schedule.find((candidate) => candidate.id === job.id);
      const deadlineSlot = boundarySlot(new Date(horizonStart.getTime() + job.deadline * 60 * 60 * 1000), horizonStart, 'floor');
      return {
        jobAlias: job.id,
        baselineStartUtc: isoAtSlot(horizonStart, before.startSlot),
        recommendedStartUtc: isoAtSlot(horizonStart, job.startSlot),
        completionUtc: isoAtSlot(horizonStart, job.endSlot),
        moveMinutes: (job.startSlot - before.startSlot) * 15,
        completionMeetsSuppliedDeadline: job.endSlot <= deadlineSlot,
        meetsCloudBatchMaxRunDuration: job.metadata.cloudBatchMaxRunDurationMinutes === null || job.metadata.cloudBatchMaxRunDurationMinutes === undefined || job.metadata.runtimeForecastMinutes <= job.metadata.cloudBatchMaxRunDurationMinutes
      };
    });
    const report = {
      ...reportBase,
      status: managed.constraints.feasible ? 'recommendations-ready' : 'best-effort-with-constraint-breaches',
      baselineSemantics: 'Counterfactual model. A supplied baselineStartUtc is operator-provided; otherwise Cloud Batch createTime is used as an earliest-eligible proxy, not as a prediction of Batch scheduler behavior.',
      constraints: {
        powerCeilingKW: signals.powerCeilingKW,
        maximum15MinuteRampKW: signals.maximum15MinuteRampKW,
        deadlineSource: 'operator-supplied local profile; Cloud Batch does not provide this completion deadline',
        runtimeSource: 'operator-supplied forecast, checked against task maxRunDuration when configured',
        solverConstraintSummary: managed.constraints,
        allSuppliedDeadlinesMet: recommendations.every((item) => item.completionMeetsSuppliedDeadline),
        allConfiguredMaxRunDurationsMet: recommendations.every((item) => item.meetsCloudBatchMaxRunDuration)
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
      blockedJobs: blockers
    };
    writePrivateJson(outPath, report);
    writePrivateJson(mappingPath, mapping);
    console.log(JSON.stringify({ status: report.status, eligibleJobs: solverJobs.length, blockedJobs: blockers.length, costChangeUSD: report.comparison.costChangeUSD, carbonChangeKg: report.comparison.carbonChangeKg, outPath, mappingPath }, null, 2));
  });
}

Promise.resolve().then(run).catch((error) => {
  console.error('PowerFlex Google Cloud Batch advisory failed: ' + error.message);
  process.exitCode = 1;
});
