import "dotenv/config";

export interface AppConfig {
  port: number;
  devinApiKey: string;
  devinApiBase: string;
  devinPollIntervalMs: number;
  devinPollTimeoutMs: number;
  gatewayApiKey: string;
  logLevel: string;
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, got: ${raw}`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const devinApiKey = env.DEVIN_API_KEY?.trim() ?? "";
  if (!devinApiKey) {
    // Allow tests to pass without it; main entrypoint enforces presence.
    // We surface a warning by throwing only when the gateway actually starts.
  }

  const devinApiBase = (env.DEVIN_API_BASE?.trim() || "https://api.devin.ai").replace(/\/+$/, "");

  return {
    port: readNumber("PORT", 8787),
    devinApiKey,
    devinApiBase,
    devinPollIntervalMs: readNumber("DEVIN_POLL_INTERVAL_MS", 3000),
    devinPollTimeoutMs: readNumber("DEVIN_POLL_TIMEOUT_MS", 600_000),
    gatewayApiKey: env.GATEWAY_API_KEY?.trim() ?? "",
    logLevel: env.LOG_LEVEL?.trim() || "info",
  };
}

export function assertRuntimeConfig(cfg: AppConfig): void {
  if (!cfg.devinApiKey) {
    throw new Error(
      "DEVIN_API_KEY is required. Set it in your environment or .env file before starting the gateway."
    );
  }
}
