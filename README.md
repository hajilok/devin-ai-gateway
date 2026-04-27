# devin-ai-gateway

A self-hosted, OpenAI-compatible HTTP gateway in front of the [Devin API](https://docs.devin.ai/api-reference/overview).
It exposes `POST /v1/chat/completions` and translates each call into a Devin
session (`POST /v1/sessions`), polling until the session reaches a terminal
state and then returning a response shaped like an OpenAI Chat Completion.

This means any tool that already speaks the OpenAI Chat Completions API
(OpenAI SDKs, LangChain, LiteLLM, Cursor/Continue/Open-WebUI, etc.) can point
its `baseURL` at this gateway and use Devin as its backend agent.

> Closes [hajilok/devin-ai-gateway#1](https://github.com/hajilok/devin-ai-gateway/issues/1).

## Architecture

```
+----------------+     OpenAI-style       +-----------------------+     Devin v1     +-------------------+
|   Your tool    |  --------------------> |  devin-ai-gateway     |  -------------> |   api.devin.ai    |
| (OpenAI SDK,   |  POST /v1/chat/        |  Express + TS         |  POST /sessions |                   |
|  curl, etc.)   |  completions           |  - messages -> prompt |  GET  /sessions |  Devin runs the   |
|                |  <-------------------- |  - poll until done    |  /{id} (poll)   |  task...          |
+----------------+   OpenAI-shaped JSON   |  - format response    | <-------------- +-------------------+
                                          +-----------------------+
```

The gateway is intentionally simple: a single endpoint, blocking polling, no
queue, no streaming yet. It is meant as a stable proof-of-concept that is easy
to extend (see [Roadmap](#roadmap)).

## Quick start (local)

Requires **Node.js 20+**.

```bash
# 1. install
npm install

# 2. configure
cp .env.example .env
# edit .env and set DEVIN_API_KEY=apk_...
# (optional) set GATEWAY_API_KEY=some-secret to require a bearer token from clients

# 3. run in dev (auto-reload)
npm run dev

# or build & run for production
npm run build
npm start
```

The gateway listens on `http://localhost:8787` by default.

### Smoke test

```bash
curl http://localhost:8787/healthz
# -> {"status":"ok"}
```

## Calling the gateway

### Without `GATEWAY_API_KEY` (auth disabled)

```bash
curl -s http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "devin",
    "messages": [
      {"role": "system", "content": "You are a careful coding agent."},
      {"role": "user",   "content": "Open the repo and add a CHANGELOG.md with the entry for v0.1.0."}
    ]
  }'
```

### With `GATEWAY_API_KEY=secret-token`

```bash
curl -s http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer secret-token" \
  -H "Content-Type: application/json" \
  -d '{ "model": "devin", "messages": [{"role":"user","content":"Run the test suite."}] }'
```

### Sample response

```json
{
  "id": "chatcmpl-9f8c...",
  "object": "chat.completion",
  "created": 1714200000,
  "model": "devin",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "All tests pass. PR opened: https://github.com/..." },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 },
  "x_devin_session_id": "devin-session-xyz",
  "x_devin_session_url": "https://app.devin.ai/sessions/devin-session-xyz"
}
```

`usage` is currently always zero because Devin does not report token usage.
The `x_devin_*` fields are non-standard helpers; OpenAI-strict clients ignore them.

### Using it from the OpenAI SDK

#### Node.js

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:8787/v1",
  apiKey: "secret-token", // value of GATEWAY_API_KEY, or any non-empty string if auth disabled
});

const res = await client.chat.completions.create({
  model: "devin",
  messages: [{ role: "user", content: "Refactor src/utils/sum.ts to use BigInt." }],
});
console.log(res.choices[0].message.content);
```

#### Python

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8787/v1", api_key="secret-token")
print(client.chat.completions.create(
    model="devin",
    messages=[{"role": "user", "content": "Bump dependencies and open a PR."}],
).choices[0].message.content)
```

## Configuration

All config is read from environment variables (see `.env.example`).

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8787` | TCP port the gateway listens on. |
| `DEVIN_API_KEY` | _required_ | Devin API key (`apk_...` or `apk_user_...`). |
| `DEVIN_API_BASE` | `https://api.devin.ai` | Override for testing or self-hosted Devin proxies. |
| `DEVIN_POLL_INTERVAL_MS` | `3000` | Delay between session polls. |
| `DEVIN_POLL_TIMEOUT_MS` | `600000` | Total wall-clock timeout for a single request (10 min). |
| `GATEWAY_API_KEY` | _empty_ | If set, clients must send `Authorization: Bearer <value>`. |
| `LOG_LEVEL` | `info` | `pino` log level (`trace` / `debug` / `info` / `warn` / `error` / `fatal` / `silent`). |

> Leaving `GATEWAY_API_KEY` empty disables auth entirely. **Do not** do that in
> production.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/healthz` | Liveness check, no auth. |
| `GET` | `/v1/models` | Static list (`devin`) for client discovery. |
| `POST` | `/v1/chat/completions` | OpenAI-compatible entrypoint. Blocks until the Devin session is finished, blocked, expired, or the configured timeout elapses. |

### Limitations

- **No streaming.** `stream: true` is rejected with `400`. (Roadmap.)
- The `model` field is currently free-form and only used for echoing back into
  the response. Mapping it onto Devin playbooks/snapshots is on the roadmap.
- `temperature`, `top_p`, `max_tokens`, `n`, etc. are accepted but **ignored**.
- `usage.*` is always `0`.

## Run with Docker

```bash
# Build
docker build -t devin-ai-gateway .

# Run (reads .env from working dir)
docker run --rm -p 8787:8787 --env-file .env devin-ai-gateway
```

Or with `docker compose`:

```bash
docker compose up --build
```

## Tests

```bash
npm test          # run once
npm run test:watch
```

The integration test stubs `fetch` so it never hits the real Devin API.

## Project layout

```
src/
  config.ts                # env loader
  index.ts                 # process entrypoint
  server.ts                # createApp() — exported for tests
  middleware/auth.ts       # optional Bearer auth on /v1/*
  routes/chatCompletions.ts# main handler
  devin/
    client.ts              # POST /sessions, GET /sessions/{id}
    poll.ts                # pollUntilDone()
    types.ts
  openai/
    messagesToPrompt.ts    # OpenAI messages[] -> prompt string
    formatResponse.ts      # session -> OpenAI Chat Completion
  utils/
    errors.ts              # OpenAI-shaped error envelope
    ids.ts                 # chatcmpl-... id generator
test/
  messagesToPrompt.test.ts
  formatResponse.test.ts
  chatCompletions.integration.test.ts
```

## Roadmap

- Streaming (`text/event-stream` SSE) compatible with the OpenAI streaming format.
- Model mapping (e.g. `model: "devin/refactor-playbook"` -> Devin `playbook_id`).
- Auth proxy (multi-tenant API key issuance, scoping to specific Devin keys).
- Async job mode (`fire-and-forget` returning a session URL right away).
- Queueing & rate limiting.
- Better observability: Prometheus metrics, request tracing.
- Deployment templates (Render, Fly.io, Kubernetes).

## License

MIT.
