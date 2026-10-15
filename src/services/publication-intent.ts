import { isAbsolute } from "node:path";
import type {
  PublicationPlan,
  PublicationStep,
  PullRequestPlan,
  RepositoryPlan,
  RepositoryVisibility,
} from "./publication.ts";

export type SavedPublicationPlan =
  Omit<RepositoryPlan, "description"> | PullRequestPlan;

export interface PublicationIntent {
  schemaVersion: 1;
  kind: "publication";
  plan: SavedPublicationPlan;
  requiresPrContent: boolean;
  requiresAttachments: boolean;
  requiresDescription: boolean;
  creationMode: "direct" | "browser";
  draft: boolean;
}

const MAX_JSON_LENGTH = 32_768;
const MAX_PATH_LENGTH = 4_096;
const MAX_BRANCH_LENGTH = 1_024;
const MAX_STEPS = 9;
const STEP_NAMES: readonly string[] = [
  "create_repository",
  "add_remote",
  "push_base",
  "push_head",
  "set_base_upstream",
  "set_head_upstream",
  "create_pull_request",
  "open_create_page",
  "upload_attachments",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\0\r\n]/.test(value)
  );
}

function isPath(value: unknown): value is string {
  return (
    isBoundedString(value, MAX_PATH_LENGTH) &&
    isAbsolute(value) &&
    !/[\0\r\n]/.test(value)
  );
}

function isTip(value: unknown): value is string {
  return (
    typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value)
  );
}

function isHost(value: unknown): value is string {
  if (!isBoundedString(value, 253) || value !== value.toLowerCase())
    return false;
  return value
    .split(".")
    .every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    );
}

function isTarget(value: unknown): value is string {
  if (!isBoundedString(value, 512)) return false;
  const parts = value.split("/");
  return (
    parts.length === 2 &&
    /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(parts[0] ?? "") &&
    /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/.test(parts[1] ?? "") &&
    parts[1] !== "." &&
    parts[1] !== ".."
  );
}

function isRemoteName(value: unknown): value is string {
  return (
    isBoundedString(value, 255) &&
    !value.startsWith("-") &&
    !value.startsWith(".") &&
    !value.endsWith(".") &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !/[\s~^:?*[\\]/.test(value)
  );
}

function isBranch(value: unknown): value is string {
  return (
    isBoundedString(value, MAX_BRANCH_LENGTH) &&
    !value.startsWith("-") &&
    !value.startsWith(".") &&
    !value.endsWith(".") &&
    !value.endsWith("/") &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !/[\s~^:?*[\\]/.test(value)
  );
}

function isSafeRemoteUrl(
  value: unknown,
  host: string,
  target: string,
): value is string {
  if (!isBoundedString(value, 2_048)) return false;
  if (value.includes("://")) {
    try {
      const parsed = new URL(value);
      const ssh = parsed.protocol === "ssh:";
      const repositoryPath = parsed.pathname.replace(/\/+$/, "").replace(/\.git$/, "");
      return (
        ["https:", "http:", "ssh:", "git:"].includes(parsed.protocol) &&
        (ssh ? parsed.username === "git" : parsed.username === "") &&
        parsed.password === "" &&
        (ssh || parsed.port === "") &&
        parsed.hostname.toLowerCase() === host &&
        repositoryPath === `/${target}` &&
        parsed.search === "" &&
        parsed.hash === ""
      );
    } catch {
      return false;
    }
  }
  return value.replace(/\/+$/, "").replace(/\.git$/, "") === `git@${host}:${target}`;
}

function validSteps(value: unknown): value is PublicationStep[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_STEPS &&
    new Set(value).size === value.length &&
    value.every(
      (step: unknown) => typeof step === "string" && STEP_NAMES.includes(step),
    )
  );
}

function parsePlan(value: unknown): SavedPublicationPlan | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (value.kind === "repo") {
    const {
      cwd,
      root,
      source,
      host,
      target,
      remote,
      remoteUrl,
      visibility,
      push,
    } = value;
    const { head, headTip, remoteHeadTip, remoteAtPrepare, steps } = value;
    if (
      !hasOnlyKeys(value, [
        "kind",
        "cwd",
        "root",
        "source",
        "host",
        "target",
        "remote",
        "remoteUrl",
        "visibility",
        "push",
        "head",
        "headTip",
        "remoteHeadTip",
        "remoteAtPrepare",
        "steps",
      ]) ||
      !isPath(cwd) ||
      (root !== undefined && !isPath(root)) ||
      (source !== undefined && !isPath(source)) ||
      !isHost(host) ||
      !isTarget(target) ||
      !isRemoteName(remote) ||
      !isSafeRemoteUrl(remoteUrl, host, target) ||
      !isVisibility(visibility) ||
      (remoteHeadTip !== undefined && !isTip(remoteHeadTip)) ||
      (remoteAtPrepare !== undefined &&
        !isSafeRemoteUrl(remoteAtPrepare, host, target)) ||
      !validSteps(steps) ||
      typeof push !== "boolean" ||
      (head !== undefined && !isBranch(head)) ||
      (headTip !== undefined && !isTip(headTip))
    )
      return null;
    return {
      kind: "repo",
      cwd,
      ...(root === undefined ? {} : { root }),
      ...(source === undefined ? {} : { source }),
      host,
      target,
      remote,
      remoteUrl,
      visibility,
      push,
      ...(head === undefined ? {} : { head }),
      ...(headTip === undefined ? {} : { headTip }),
      ...(remoteHeadTip === undefined ? {} : { remoteHeadTip }),
      ...(remoteAtPrepare === undefined ? {} : { remoteAtPrepare }),
      steps,
    };
  }
  if (value.kind === "pr") {
    const { cwd, root, source, host, target, remote, remoteUrl, visibility } =
      value;
    const { remoteAtPrepare, createRepository, head, headTip, remoteHeadTip } =
      value;
    const { base, baseTip, localBaseTip, remoteBaseTip, mergeBaseTip, steps } = value;
    if (
      !hasOnlyKeys(value, [
        "kind",
        "cwd",
        "root",
        "source",
        "host",
        "target",
        "remote",
        "remoteUrl",
        "visibility",
        "remoteAtPrepare",
        "createRepository",
        "head",
        "headTip",
        "remoteHeadTip",
        "base",
        "baseTip",
        "localBaseTip",
        "remoteBaseTip",
        "mergeBaseTip",
        "steps",
      ]) ||
      !isPath(cwd) ||
      !isPath(root) ||
      (source !== undefined && !isPath(source)) ||
      !isHost(host) ||
      !isTarget(target) ||
      !isRemoteName(remote) ||
      !isSafeRemoteUrl(remoteUrl, host, target) ||
      !isVisibility(visibility) ||
      (remoteAtPrepare !== undefined &&
        !isSafeRemoteUrl(remoteAtPrepare, host, target)) ||
      typeof createRepository !== "boolean" ||
      !isBranch(head) ||
      !isTip(headTip) ||
      (remoteHeadTip !== undefined && !isTip(remoteHeadTip)) ||
      !isBranch(base) ||
      !isTip(baseTip) ||
      (localBaseTip !== undefined && !isTip(localBaseTip)) ||
      (remoteBaseTip !== undefined && !isTip(remoteBaseTip)) ||
      !isTip(mergeBaseTip) ||
      !validSteps(steps)
    )
      return null;
    return {
      kind: "pr",
      cwd,
      root,
      ...(source === undefined ? {} : { source }),
      host,
      target,
      remote,
      remoteUrl,
      visibility,
      ...(remoteAtPrepare === undefined ? {} : { remoteAtPrepare }),
      createRepository,
      head,
      headTip,
      ...(remoteHeadTip === undefined ? {} : { remoteHeadTip }),
      base,
      baseTip,
      ...(localBaseTip === undefined ? {} : { localBaseTip }),
      ...(remoteBaseTip === undefined ? {} : { remoteBaseTip }),
      mergeBaseTip,
      steps,
    };
  }
  return null;
}

function isVisibility(value: unknown): value is RepositoryVisibility {
  return value === "public" || value === "private" || value === "internal";
}

function isWithinJsonLimit(value: unknown): boolean {
  try {
    const serialized = JSON.stringify(value);
    return serialized !== undefined && serialized.length <= MAX_JSON_LENGTH;
  } catch {
    return false;
  }
}

export function publicationIntent(
  plan: PublicationPlan,
  options: { attachments?: readonly string[]; draft?: boolean; web?: boolean } = {},
): PublicationIntent {
  const savedPlan: SavedPublicationPlan =
    plan.kind === "repo"
      ? {
          kind: plan.kind,
          cwd: plan.cwd,
          ...(plan.root === undefined ? {} : { root: plan.root }),
          ...(plan.source === undefined ? {} : { source: plan.source }),
          host: plan.host,
          target: plan.target,
          remote: plan.remote,
          remoteUrl: plan.remoteUrl,
          visibility: plan.visibility,
          push: plan.push,
          ...(plan.head === undefined ? {} : { head: plan.head }),
          ...(plan.headTip === undefined ? {} : { headTip: plan.headTip }),
          ...(plan.remoteHeadTip === undefined
            ? {}
            : { remoteHeadTip: plan.remoteHeadTip }),
          ...(plan.remoteAtPrepare === undefined
            ? {}
            : { remoteAtPrepare: plan.remoteAtPrepare }),
          steps: [...plan.steps],
        }
      : {
          kind: plan.kind,
          cwd: plan.cwd,
          root: plan.root,
          ...(plan.source === undefined ? {} : { source: plan.source }),
          host: plan.host,
          target: plan.target,
          remote: plan.remote,
          remoteUrl: plan.remoteUrl,
          visibility: plan.visibility,
          ...(plan.remoteAtPrepare === undefined
            ? {}
            : { remoteAtPrepare: plan.remoteAtPrepare }),
          createRepository: plan.createRepository,
          head: plan.head,
          headTip: plan.headTip,
          ...(plan.remoteHeadTip === undefined
            ? {}
            : { remoteHeadTip: plan.remoteHeadTip }),
          base: plan.base,
          baseTip: plan.baseTip,
          ...(plan.localBaseTip === undefined ? {} : { localBaseTip: plan.localBaseTip }),
          ...(plan.remoteBaseTip === undefined ? {} : { remoteBaseTip: plan.remoteBaseTip }),
          mergeBaseTip: plan.mergeBaseTip,
          steps: [...plan.steps],
        };
  return {
    schemaVersion: 1,
    kind: "publication",
    plan: savedPlan,
    requiresPrContent: plan.kind === "pr",
    requiresAttachments: plan.kind === "pr" && (options.attachments?.length ?? 0) > 0,
    requiresDescription: plan.kind === "repo" && Boolean(plan.description),
    creationMode: plan.kind === "pr" && options.web ? "browser" : "direct",
    draft: plan.kind === "pr" && Boolean(options.draft),
  };
}

export function parsePublicationIntent(raw: unknown): PublicationIntent {
  if (
    !isRecord(raw) ||
    !hasOnlyKeys(raw, [
      "schemaVersion",
      "kind",
      "plan",
      "requiresPrContent",
      "requiresAttachments",
      "requiresDescription",
      "creationMode",
      "draft",
    ]) ||
    raw.schemaVersion !== 1 ||
    raw.kind !== "publication" ||
    typeof raw.requiresPrContent !== "boolean" ||
    typeof raw.requiresAttachments !== "boolean" ||
    typeof raw.requiresDescription !== "boolean" ||
    (raw.creationMode !== "direct" && raw.creationMode !== "browser") ||
    typeof raw.draft !== "boolean" ||
    !isWithinJsonLimit(raw)
  )
    throw new Error("Invalid publication intent.");

  const plan = parsePlan(raw.plan);
  if (
    !plan ||
    raw.requiresPrContent !== (plan.kind === "pr") ||
    (plan.kind === "pr" && raw.requiresDescription) ||
    (plan.kind === "repo" && (raw.requiresAttachments || raw.creationMode !== "direct" || raw.draft)) ||
    (raw.creationMode === "browser" && raw.requiresAttachments)
  )
    throw new Error("Invalid publication intent.");

  return {
    schemaVersion: 1,
    kind: "publication",
    plan,
    requiresPrContent: raw.requiresPrContent,
    requiresAttachments: raw.requiresAttachments,
    requiresDescription: raw.requiresDescription,
    creationMode: raw.creationMode,
    draft: raw.draft,
  };
}
