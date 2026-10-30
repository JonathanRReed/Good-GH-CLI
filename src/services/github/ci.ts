import { createHash } from "node:crypto";
import { responseValidators } from "./response.ts";
import { gh, ghApi, classifyGitHubError } from "./client.ts";
import { extractEvidence, evidenceSignature, needsFullJobLog, type EvidenceLine, type Truncation } from "../ci-evidence.ts";

interface Step { name: string; conclusion: string; number: number }
interface Job { name: string; conclusion: string; databaseId: number; url: string; steps: Step[] }
interface Run { databaseId: number; headSha: string; url: string; workflowName: string; conclusion: string; jobs: Job[]; event?: string }
interface PullRequest { number: number; url: string; headRefOid: string; failedChecks: string[] }
export interface Annotation { path: string; startLine: number; endLine: number; level: string; title: string; message: string; rawDetails: string }
export interface CiFailure {
  job: string; step: string; url: string; annotations: Annotation[]; evidence: EvidenceLine[];
  logSource: "failed-step" | "full-job"; truncated: Truncation;
  annotationsTruncated?: Truncation;
  jobs?: Array<{ job: string; step: string; url: string; runId: number; logSource: CiFailure["logSource"] }>;
}
export interface CiEvidence {
  schemaVersion: 1;
  repository: string;
  outputTruncated?: { bytesTotal: number; maxBytes: number; evidenceLines: number; annotations: number; jobs: number; failures: number; runs: number; unavailable: number };
  pr?: { number: number; url: string };
  headSha: string;
  runs: Array<{ id: number; url: string; workflow: string; event?: string; conclusion: string; sha: string; stale: boolean }>;
  failures: CiFailure[];
  unavailable: Array<{ source: string; reason: string; runId?: number; job?: string }>;
}

const { object, array, string, integer } = responseValidators({ label: "GitHub" });
function parseRun(value: unknown): Run {
  const r = object(value);
  return {
    databaseId: integer(r.databaseId), headSha: string(r.headSha), url: string(r.url),
    workflowName: string(r.workflowName), conclusion: r.conclusion === null ? "" : string(r.conclusion),
    jobs: array(r.jobs).map(value => {
      const j = object(value);
      return {
        databaseId: integer(j.databaseId), name: string(j.name), url: string(j.url),
        conclusion: j.conclusion === null ? "" : string(j.conclusion),
        steps: array(j.steps ?? []).map(value => {
          const s = object(value);
          return { name: string(s.name), number: integer(s.number), conclusion: s.conclusion === null ? "" : string(s.conclusion) };
        }),
      };
    }),
  };
}
const failed = (conclusion: string) => ["failure", "timed_out", "cancelled", "startup_failure", "action_required"].includes(conclusion);
const reason = (err: unknown) => err instanceof Error ? err.message : String(err);

export async function collectCiEvidence(options: { target?: string; run?: boolean; maxBytes: number; context: number }): Promise<CiEvidence> {
  const result: CiEvidence = { schemaVersion: 1, repository: "", headSha: "", runs: [], failures: [], unavailable: [] };
  const unavailable = (source: string, err: unknown, runId?: number, job?: string) => {
    result.unavailable.push({ source, reason: reason(err), ...(runId === undefined ? {} : { runId }), ...(job === undefined ? {} : { job }) });
  };
  async function viewRun(id: string): Promise<Run> {
    const { stdout } = await gh(["run", "view", id, "--json", "databaseId,headSha,url,workflowName,conclusion,jobs"]);
    return parseRun(JSON.parse(stdout));
  }
  let pr: PullRequest | undefined;
  let directRun: Run | undefined;
  if (options.run) {
    if (!options.target) throw new Error("A run ID is required with --run.");
    directRun = await viewRun(options.target);
  } else {
    try {
      const { stdout } = await gh(["pr", "view", ...(options.target ? [options.target] : []), "--json", "number,url,headRefOid,statusCheckRollup"]);
      const p = object(JSON.parse(stdout));
      pr = { number: integer(p.number), url: string(p.url), headRefOid: string(p.headRefOid),
        failedChecks: array(p.statusCheckRollup ?? []).flatMap(value => {
          const check = object(value);
          return failed(String(check.conclusion ?? "").toLowerCase()) || ["FAILURE", "ERROR"].includes(String(check.state))
            ? [string(check.name ?? check.context ?? "unknown check")] : [];
        }) };
    } catch (err) {
      // Numeric IDs overlap. Only a missing PR permits the read-only run fallback.
      const missingPr = classifyGitHubError(err).kind === "not_found" || /could not resolve to a PullRequest with the number|no pull requests found/i.test(reason(err));
      if (!options.target || !/^\d+$/.test(options.target) || !missingPr) throw err;
      directRun = await viewRun(options.target);
    }
  }
  result.headSha = pr ? pr.headRefOid : directRun?.headSha ?? "";
  const targetUrl = new URL(pr?.url ?? directRun?.url ?? "");
  result.repository = targetUrl.pathname.split("/").slice(1, 3).join("/");
  if (pr) result.pr = { number: pr.number, url: pr.url };
  const runs: Run[] = [];
  if (directRun) runs.push(directRun);
  else {
    const workflows = new Set<string>();
    const seenRuns = new Set<number>();
    for (let page = 1; page <= 10; page++) {
      let rows: unknown[];
      try {
        const { stdout } = await ghApi([`repos/{owner}/{repo}/actions/runs?head_sha=${encodeURIComponent(result.headSha)}&per_page=100&page=${page}`]);
        rows = array(object(JSON.parse(stdout)).workflow_runs);
      } catch (err) { unavailable("runs", err); break; }
      for (const row of rows) {
        const r = object(row);
        const workflow = integer(r.workflow_id);
        const event = string(r.event ?? "unknown");
        const key = `${workflow}:${event}`;
        const id = integer(r.id);
        if (seenRuns.has(id)) continue;
        seenRuns.add(id);
        // The API lists newest runs first. Retain older completed failures too.
        if (workflows.has(key) && !failed(String(r.conclusion ?? ""))) continue;
        workflows.add(key);
        try { runs.push({ ...await viewRun(String(id)), event }); }
        catch (err) { unavailable("run", err, id); }
      }
      if (rows.length < 100) break;
      if (page === 10) unavailable("runs", "Run pagination stopped at 1,000 runs; workflow coverage may be incomplete.");
    }
    if (!runs.length && !result.unavailable.length) unavailable("runs", "No runs found for the PR head SHA.");
  }

  async function annotations(job: Job, run: Run): Promise<{ annotations: Annotation[]; truncated: Truncation; signature: string }> {
    const annotations: Annotation[] = [];
    const signature = createHash("sha256");
    let bytesTotal = 0;
    let bytesShown = 0;
    try {
      const { stdout } = await ghApi([`repos/{owner}/{repo}/actions/jobs/${job.databaseId}`]);
      const checkUrl = string(object(JSON.parse(stdout)).check_run_url);
      const checkId = /\/check-runs\/(\d+)$/.exec(checkUrl)?.[1];
      if (!checkId) throw new Error("Job has no check-run annotations URL.");
      for (let page = 1; page <= 10; page++) {
        const { stdout } = await ghApi([`repos/{owner}/{repo}/check-runs/${checkId}/annotations?per_page=100&page=${page}`]);
        const rows = array(JSON.parse(stdout));
        for (const row of rows) {
          const a = object(row);
          const annotation = { path: string(a.path), startLine: integer(a.start_line), endLine: integer(a.end_line),
            level: string(a.annotation_level), title: string(a.title ?? ""), message: string(a.message), rawDetails: string(a.raw_details ?? "") };
          const serialized = JSON.stringify(annotation);
          signature.update(serialized + "\n");
          const size = Buffer.byteLength(serialized);
          bytesTotal += size;
          if (bytesShown + size <= options.maxBytes) { annotations.push(annotation); bytesShown += size; }
        }
        if (rows.length < 100) break;
        if (page === 10) unavailable("annotations", "Annotation pagination stopped at 1,000 entries; byte totals cover fetched entries only.", run.databaseId, job.name);
      }
    } catch (err) { unavailable("annotations", err, run.databaseId, job.name); }
    return { annotations, truncated: { bytesTotal, bytesShown }, signature: signature.digest("hex") };
  }

  const groups = new Map<string, CiFailure>();
  for (const run of runs) {
    const stale = run.headSha !== result.headSha;
    result.runs.push({ id: run.databaseId, url: run.url, workflow: run.workflowName, ...(run.event ? { event: run.event } : {}), conclusion: run.conclusion, sha: run.headSha, stale });
    if (stale) {
      unavailable("stale-run", `Run SHA ${run.headSha} does not match head SHA ${result.headSha}; evidence excluded.`, run.databaseId);
      continue;
    }
    const jobs = run.jobs.filter(job => failed(job.conclusion));
    if (failed(run.conclusion) && !jobs.length) unavailable("jobs", "Run failed without available failing jobs.", run.databaseId);
    for (const job of jobs) {
      const annotated = await annotations(job, run);
      let log = "";
      let logSource: CiFailure["logSource"] = "failed-step";
      let runInProgress = false;
      try {
        log = (await gh(["run", "view", String(run.databaseId), "--job", String(job.databaseId), "--log-failed"], { timeoutMs: 60_000 })).stdout;
      } catch (err) {
        // gh withholds every log until the whole run ends; the jobs API serves a finished job's log now.
        if (/still in progress/i.test(err instanceof Error ? err.message : String(err))) runInProgress = true;
        else unavailable("failed-step", err, run.databaseId, job.name);
      }
      if (runInProgress) {
        try {
          const full = (await ghApi(["--allow-escape-sequences", `repos/{owner}/{repo}/actions/jobs/${job.databaseId}/logs`], { timeoutMs: 60_000 })).stdout;
          if (full.trim()) { log = full; logSource = "full-job"; }
          else unavailable("full-job", "Empty job log.", run.databaseId, job.name);
        } catch (err) { unavailable("full-job", err, run.databaseId, job.name); }
      } else if (needsFullJobLog(log)) {
        try {
          const full = (await gh(["run", "view", String(run.databaseId), "--job", String(job.databaseId), "--log"], { timeoutMs: 60_000 })).stdout;
          if (full.trim()) { log = full; logSource = "full-job"; }
          else unavailable("full-job", "Empty job log.", run.databaseId, job.name);
        } catch (err) { unavailable("full-job", err, run.databaseId, job.name); }
      }
      if (!log.trim()) unavailable("log", "No log evidence available.", run.databaseId, job.name);
      const steps = job.steps.filter(step => failed(step.conclusion));
      // One bundle per job retains all failing steps without duplicating its log or budget.
      const step = steps.map(step => `${step.number}: ${step.name}`).join("; ") || "unknown";
      const member = { job: job.name, step, url: job.url, runId: run.databaseId, logSource };
      // Compare full normalized error lines before applying byte limits. Empty evidence never groups.
      const signature = evidenceSignature(log);
      const key = JSON.stringify([signature, annotated.signature]);
      const group = signature ? groups.get(key) : undefined;
      if (group) {
        group.jobs?.push(member);
        continue;
      }
      const failure: CiFailure = { job: job.name, step, url: job.url, annotations: annotated.annotations,
        ...(annotated.truncated.bytesShown < annotated.truncated.bytesTotal ? { annotationsTruncated: annotated.truncated } : {}),
        ...extractEvidence(log, Math.max(0, options.maxBytes - annotated.truncated.bytesShown), options.context), logSource,
        jobs: [member] };
      result.failures.push(failure);
      if (signature) groups.set(key, failure);
    }
  }
  for (const failure of result.failures) if (failure.jobs?.length === 1) delete failure.jobs;
  if (pr?.failedChecks.length && !result.failures.length) {
    unavailable("checks", `PR head checks report failures (${pr.failedChecks.join(", ")}), but Actions returned no failing jobs. Check ${pr.url}/checks.`);
  }
  return result;
}
