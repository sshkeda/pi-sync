import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiPendingRegistry, PiPendingDetails } from "pi-pending";

export type BackgroundToolClock = () => number;
export type BackgroundToolSetTimeout = typeof setTimeout;

export interface BackgroundToolResultContent {
  type: "text";
  text: string;
}

export interface BackgroundToolResult {
  content: BackgroundToolResultContent[];
  details?: Record<string, unknown>;
}

export type BackgroundToolSendMessage = ExtensionAPI["sendMessage"];

export type BackgroundPolicy =
  | { mode: "never" }
  | { mode: "threshold"; afterMs: number }
  | { mode: "immediate" };

export interface BackgroundToolPendingPayload<Update = unknown> {
  id: string;
  label?: string;
  text: string;
  startedAt: number;
  details?: PiPendingDetails;
  update?: Update;
}

export interface BackgroundToolRunContext<Update = unknown> {
  signal: AbortSignal;
  onUpdate(update: Update): void;
}

export interface BackgroundToolRunOptions<T, Update = unknown> {
  /** Stable pending/result id, usually the Pi toolCallId or an extension query id. */
  id: string;
  /** Human label shown in pi-pending. */
  label?: string;
  /** Short user/task text shown in pi-pending and background handoff details. */
  text: string;
  /** Tool call context. If no UI is present, run waits normally and never auto-backgrounds. */
  ctx?: Pick<ExtensionContext, "hasUI" | "ui">;
  /** Original cancellation signal from the tool execute callback. */
  signal?: AbortSignal;
  /** Background policy override for this run. */
  background?: BackgroundPolicy;
  /** @deprecated Use background: { mode: "threshold", afterMs } or { mode: "immediate" }. */
  backgroundAfterMs?: number;
  /** Start time for elapsed pending display. Default: now(). */
  startedAt?: number;
  /** Initial pending details. */
  details?: PiPendingDetails;
  /** The actual tool work. Starts immediately. */
  run(context: BackgroundToolRunContext<Update>): Promise<T>;
  /** Render a fast inline result or non-UI result. */
  renderResult(result: T, meta: { id: string; durationMs: number; backgrounded: boolean }): BackgroundToolResult;
  /** Render the immediate result returned once a slow call is promoted to background. */
  renderBackgrounded?(meta: { id: string; backgroundAfterMs: number }): BackgroundToolResult;
  /** Render an error if it happens before promotion or in a non-UI call. */
  renderError?(error: unknown, meta: { id: string; durationMs: number; backgrounded: boolean }): BackgroundToolResult;
  /** Convert progress updates into pending row patches. Called only after background promotion. */
  renderPendingUpdate?(update: Update, meta: { id: string; current: BackgroundToolPendingPayload<Update> }): Partial<BackgroundToolPendingPayload<Update>>;
  /** Render final follow-up message content after a backgrounded result completes. */
  renderBackgroundResult?(result: T, meta: { id: string; durationMs: number }): string;
  /** Render final follow-up message details after a backgrounded result completes. */
  renderBackgroundResultDetails?(result: T, meta: { id: string; durationMs: number }): Record<string, unknown>;
  /** Render final follow-up message content after a backgrounded result fails. */
  renderBackgroundError?(error: unknown, meta: { id: string; durationMs: number }): string;
  /** Render final follow-up message details after a backgrounded result fails. */
  renderBackgroundErrorDetails?(error: unknown, meta: { id: string; durationMs: number }): Record<string, unknown>;
}

export interface BackgroundToolInjection {
  id: string;
  content: string;
  details: Record<string, unknown>;
}

export type BackgroundToolInjectionWaiter = (injection: BackgroundToolInjection) => Promise<void> | void;

export interface BackgroundToolRunnerOptions {
  pending: PiPendingRegistry;
  sendMessage: BackgroundToolSendMessage;
  /** Optional hook that resolves only after the background message is included in a provider request. */
  waitForInjection?: BackgroundToolInjectionWaiter;
  /** Default background policy. Default: { mode: "threshold", afterMs: 30_000 }. */
  background?: BackgroundPolicy;
  /** @deprecated Use background: { mode: "threshold", afterMs } or { mode: "immediate" }. */
  backgroundAfterMs?: number;
  now?: BackgroundToolClock;
  setTimeoutFn?: BackgroundToolSetTimeout;
}

export interface BackgroundToolRunner {
  run<T, Update = unknown>(options: BackgroundToolRunOptions<T, Update>): Promise<BackgroundToolResult>;
}

export interface BackgroundJobStartOptions {
  id: string;
  label?: string;
  text: string;
  ctx?: Pick<ExtensionContext, "hasUI" | "ui">;
  signal?: AbortSignal;
  startedAt?: number;
  details?: PiPendingDetails;
}

export interface BackgroundJobUpdateOptions {
  label?: string;
  text?: string;
  details?: PiPendingDetails;
}

export interface BackgroundJobDeliveryOptions {
  content: string;
  details?: Record<string, unknown>;
  customType?: string;
  display?: boolean;
  delivery?: Parameters<BackgroundToolSendMessage>[1];
}

export interface BackgroundJob {
  readonly id: string;
  update(patch: BackgroundJobUpdateOptions): void;
  complete(delivery: BackgroundJobDeliveryOptions): Promise<void>;
  fail(delivery: BackgroundJobDeliveryOptions): Promise<void>;
  finish(): void;
}

export interface BackgroundJobRunner {
  start(options: BackgroundJobStartOptions): BackgroundJob;
}

function defaultBackgroundedResult(id: string): BackgroundToolResult {
  return {
    content: [{ type: "text", text: "Still running in the background; result will appear here." }],
    details: { id, deferred: true },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// pi-sync / pi-lane host processes run headless (ctx.hasUI === false) but
// drive attached terminals over a sync directory. pi-pending mirrors pending
// rows through that directory, so the background lifecycle should still
// engage when a sync session is wired up even though the host itself has no
// local UI.
function hasAttachedSyncSession(): boolean {
  return Boolean(
    process.env.PI_SYNC_SESSION_KEY ||
      process.env.PI_LANE_SESSION_KEY ||
      process.env.PI_SYNC_HOST_PROCESS === "1",
  );
}

function defaultErrorResult(error: unknown, id: string): BackgroundToolResult {
  return {
    content: [{ type: "text", text: errorMessage(error) }],
    details: { id, error: errorMessage(error) },
  };
}

function defaultBackgroundResult<T>(result: T): string {
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2);
}

function clearTimer(timer: ReturnType<typeof setTimeout> | undefined): void {
  if (timer !== undefined) clearTimeout(timer);
}

function policyFromLegacyThreshold(backgroundAfterMs: number): BackgroundPolicy {
  return backgroundAfterMs === 0
    ? { mode: "immediate" }
    : { mode: "threshold", afterMs: Math.max(0, backgroundAfterMs) };
}

function normalizeBackgroundPolicy({
  runBackground,
  runnerBackground,
  runBackgroundAfterMs,
  runnerBackgroundAfterMs,
}: {
  runBackground: BackgroundPolicy | undefined;
  runnerBackground: BackgroundPolicy | undefined;
  runBackgroundAfterMs: number | undefined;
  runnerBackgroundAfterMs: number;
}): BackgroundPolicy {
  if (runBackground) return runBackground;
  if (runnerBackground) return runnerBackground;
  if (runBackgroundAfterMs !== undefined) return policyFromLegacyThreshold(runBackgroundAfterMs);
  return policyFromLegacyThreshold(runnerBackgroundAfterMs);
}

function backgroundAfterMsForRender(policy: BackgroundPolicy): number {
  return policy.mode === "threshold" ? policy.afterMs : 0;
}

export interface ProviderRequestInjectionWatcherOptions {
  timeoutMs?: number;
  setTimeoutFn?: BackgroundToolSetTimeout;
  /**
   * Wait until Pi receives provider response headers after the matching payload.
   * This is stronger than resolving at before_provider_request, because it proves
   * Pi got past provider dispatch for the request containing the background text.
   */
  waitForProviderResponse?: boolean;
}

interface ProviderRequestWaiter {
  injection: BackgroundToolInjection;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  observedInPayload: boolean;
}

export function createProviderRequestInjectionWatcher(
  pi: Pick<ExtensionAPI, "on">,
  {
    timeoutMs = 120_000,
    setTimeoutFn = setTimeout,
    waitForProviderResponse = true,
  }: ProviderRequestInjectionWatcherOptions = {},
): BackgroundToolInjectionWaiter {
  const waiters = new Map<string, ProviderRequestWaiter>();

  const resolveWaiter = (id: string, waiter: ProviderRequestWaiter): void => {
    clearTimeout(waiter.timer);
    waiters.delete(id);
    waiter.resolve();
  };

  pi.on("before_provider_request", (event: { payload?: unknown }) => {
    const payloadText = JSON.stringify(event.payload ?? "");
    for (const [id, waiter] of [...waiters]) {
      if (payloadText.includes(waiter.injection.content) || payloadText.includes(JSON.stringify(waiter.injection.content).slice(1, -1))) {
        waiter.observedInPayload = true;
        if (!waitForProviderResponse) resolveWaiter(id, waiter);
      }
    }
  });

  pi.on("after_provider_response", () => {
    if (!waitForProviderResponse) return;
    for (const [id, waiter] of [...waiters]) {
      if (waiter.observedInPayload) resolveWaiter(id, waiter);
    }
  });

  return (injection: BackgroundToolInjection) => new Promise<void>((resolve, reject) => {
    const timer = setTimeoutFn(() => {
      waiters.delete(injection.id);
      reject(new Error(`Background tool result was not observed in a provider request within ${Math.round(timeoutMs / 1000)}s. id=${injection.id}`));
    }, timeoutMs);
    waiters.set(injection.id, { injection, resolve, reject, timer, observedInPayload: false });
  });
}

export function createBackgroundJobRunner({
  pending,
  sendMessage,
  waitForInjection,
  now = () => Date.now(),
}: Pick<BackgroundToolRunnerOptions, "pending" | "sendMessage" | "waitForInjection" | "now">): BackgroundJobRunner {
  return {
    start(options: BackgroundJobStartOptions): BackgroundJob {
      const startedAt = options.startedAt ?? now();
      let finished = false;
      const ui = options.ctx?.ui;
      // Show the pending row whenever we have a local UI OR whenever we are
      // running inside a pi-sync host whose attached terminals can render the
      // mirrored row through pi-pending's lane sync directory.
      const hasPending = Boolean(options.ctx?.hasUI && ui) || hasAttachedSyncSession();
      if (hasPending) {
        if (ui) pending.attach(ui);
        pending.start({
          id: options.id,
          text: options.text,
          startedAt,
          ...(options.label !== undefined ? { label: options.label } : {}),
          ...(options.details !== undefined ? { details: options.details } : {}),
        });
      }

      const finish = (): void => {
        if (finished) return;
        finished = true;
        if (hasPending) pending.finish(options.id);
      };

      const deliver = async (delivery: BackgroundJobDeliveryOptions, status: "completed" | "failed"): Promise<void> => {
        const durationMs = now() - startedAt;
        const details = delivery.details ?? { id: options.id, status, duration_ms: durationMs };
        const observed = waitForInjection?.({ id: options.id, content: delivery.content, details });
        await Promise.resolve(sendMessage(
          {
            customType: delivery.customType ?? "background-tool-result",
            content: delivery.content,
            display: delivery.display ?? true,
            details,
          },
          delivery.delivery ?? { deliverAs: "steer", triggerTurn: true },
        ));
        try {
          await Promise.resolve(observed);
        } finally {
          finish();
        }
      };

      return {
        id: options.id,
        update(patch: BackgroundJobUpdateOptions): void {
          if (!hasPending || finished) return;
          pending.update(options.id, patch);
        },
        complete(delivery: BackgroundJobDeliveryOptions): Promise<void> {
          return deliver(delivery, "completed");
        },
        fail(delivery: BackgroundJobDeliveryOptions): Promise<void> {
          return deliver(delivery, "failed");
        },
        finish,
      };
    },
  };
}

export function createBackgroundToolRunner({
  pending,
  sendMessage,
  waitForInjection,
  background,
  backgroundAfterMs = 30_000,
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
}: BackgroundToolRunnerOptions): BackgroundToolRunner {
  const jobs = createBackgroundJobRunner({
    pending,
    sendMessage,
    now,
    ...(waitForInjection !== undefined ? { waitForInjection } : {}),
  });
  return {
    async run<T, Update = unknown>(options: BackgroundToolRunOptions<T, Update>): Promise<BackgroundToolResult> {
      const startedAt = options.startedAt ?? now();
      const policy = normalizeBackgroundPolicy({
        runBackground: options.background,
        runnerBackground: background,
        runBackgroundAfterMs: options.backgroundAfterMs,
        runnerBackgroundAfterMs: backgroundAfterMs,
      });
      const interactive = Boolean(options.ctx?.hasUI && options.ctx.ui) || hasAttachedSyncSession();
      const abort = new AbortController();
      const sourceSignal = options.signal;
      const abortFromSource = () => abort.abort(sourceSignal?.reason);
      if (sourceSignal?.aborted) abortFromSource();
      else sourceSignal?.addEventListener("abort", abortFromSource, { once: true });

      let backgrounded = false;
      let backgroundJob: BackgroundJob | undefined;
      let pendingPayload: BackgroundToolPendingPayload<Update> = {
        id: options.id,
        text: options.text,
        startedAt,
        ...(options.label !== undefined ? { label: options.label } : {}),
        ...(options.details !== undefined ? { details: options.details } : {}),
      };

      const startPending = (): void => {
        if (backgrounded) return;
        backgrounded = true;
        backgroundJob = jobs.start({
          id: options.id,
          text: pendingPayload.text,
          startedAt,
          signal: abort.signal,
          ...(options.ctx !== undefined ? { ctx: options.ctx } : {}),
          ...(pendingPayload.label !== undefined ? { label: pendingPayload.label } : {}),
          ...(pendingPayload.details !== undefined ? { details: pendingPayload.details } : {}),
        });
      };

      const completion = (async () => {
        try {
          const value = await options.run({
            signal: abort.signal,
            onUpdate(update: Update) {
              pendingPayload = { ...pendingPayload, update };
              const patch = options.renderPendingUpdate?.(update, { id: options.id, current: pendingPayload }) ?? {};
              pendingPayload = { ...pendingPayload, ...patch };
              if (!backgrounded) return;
              backgroundJob?.update({
                ...(pendingPayload.label !== undefined ? { label: pendingPayload.label } : {}),
                text: pendingPayload.text,
                ...(pendingPayload.details !== undefined ? { details: pendingPayload.details } : {}),
              });
            },
          });
          return value;
        } finally {
          sourceSignal?.removeEventListener("abort", abortFromSource);
        }
      })();

      if (!interactive) {
        try {
          const result = await completion;
          return options.renderResult(result, { id: options.id, durationMs: now() - startedAt, backgrounded: false });
        } catch (error) {
          return options.renderError?.(error, { id: options.id, durationMs: now() - startedAt, backgrounded: false }) ?? defaultErrorResult(error, options.id);
        }
      }

      const promoteToBackground = (): BackgroundToolResult => {
        startPending();
        void completion.then(
          async (result) => {
            const durationMs = now() - startedAt;
            const content = options.renderBackgroundResult?.(result, { id: options.id, durationMs }) ?? defaultBackgroundResult(result);
            const details = options.renderBackgroundResultDetails?.(result, { id: options.id, durationMs }) ?? { id: options.id, status: "completed", duration_ms: durationMs };
            const job = backgroundJob;
            if (!job) throw new Error(`Background job missing for ${options.id}`);
            await job.complete({ content, details });
          },
          async (error) => {
            const durationMs = now() - startedAt;
            const content = options.renderBackgroundError?.(error, { id: options.id, durationMs }) ?? errorMessage(error);
            const details = options.renderBackgroundErrorDetails?.(error, { id: options.id, durationMs }) ?? { id: options.id, status: "failed", duration_ms: durationMs, error: errorMessage(error) };
            const job = backgroundJob;
            if (!job) throw new Error(`Background job missing for ${options.id}`);
            await job.fail({ content, details });
          },
        );
        return options.renderBackgrounded?.({ id: options.id, backgroundAfterMs: backgroundAfterMsForRender(policy) }) ?? defaultBackgroundedResult(options.id);
      };

      if (policy.mode === "never") {
        try {
          const result = await completion;
          return options.renderResult(result, { id: options.id, durationMs: now() - startedAt, backgrounded: false });
        } catch (error) {
          return options.renderError?.(error, { id: options.id, durationMs: now() - startedAt, backgrounded: false }) ?? defaultErrorResult(error, options.id);
        }
      }

      if (policy.mode === "immediate") return promoteToBackground();

      let timer: ReturnType<typeof setTimeout> | undefined;
      const backgroundSignal = new Promise<"background">((resolve) => {
        timer = setTimeoutFn(() => resolve("background"), Math.max(0, policy.afterMs));
      });

      const first = await Promise.race([completion, backgroundSignal]);
      if (first !== "background") {
        clearTimer(timer);
        return options.renderResult(first, { id: options.id, durationMs: now() - startedAt, backgrounded: false });
      }

      return promoteToBackground();
    },
  };
}
