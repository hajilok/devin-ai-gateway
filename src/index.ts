import { pino } from "pino";
import { assertRuntimeConfig, loadConfig } from "./config.js";
import { createApp } from "./server.js";

function main(): void {
  const config = loadConfig();
  assertRuntimeConfig(config);

  const logger = pino({ level: config.logLevel });
  if (!config.gatewayApiKey) {
    logger.warn(
      "GATEWAY_API_KEY is not set — the gateway is exposed without authentication. Set it in production."
    );
  }

  const app = createApp({ config, logger });
  app.listen(config.port, () => {
    logger.info(
      { port: config.port, devinApiBase: config.devinApiBase },
      "devin-ai-gateway listening"
    );
  });
}

main();
