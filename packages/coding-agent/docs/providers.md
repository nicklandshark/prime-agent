# Providers

Prime Agent supports subscription-based providers via OAuth and API key providers via environment variables or the auth file. Its built-in model catalog is updated with each Prime Agent release.

## Table of Contents

- [Subscriptions](#subscriptions)
- [API Keys](#api-keys)
- [Auth File](#auth-file)
- [Cloud Providers](#cloud-providers)
- [Custom Providers](#custom-providers)
- [Resolution Order](#resolution-order)

## Subscriptions

Use `/login` in interactive mode, then select a provider:

- ChatGPT Plus/Pro (Codex)
- Claude Pro/Max
- GitHub Copilot
- Cursor Subscription (`cursor-not-cloud`)

Use `/logout` to clear credentials. Tokens are stored in `~/.prime/agent/auth.json` and auto-refresh when expired.

### OpenAI Codex

- Requires ChatGPT Plus or Pro subscription
- Officially endorsed by OpenAI: [Codex for OSS](https://developers.openai.com/community/codex-for-oss)

### Claude Pro/Max

Anthropic subscription auth is active for Claude Pro/Max accounts. Third-party harness usage draws from [extra usage](https://claude.ai/settings/usage) and is billed per token, not against Claude plan limits.

### GitHub Copilot

- Press Enter for github.com, or enter your GitHub Enterprise Server domain
- If you get "model not supported", enable it in VS Code: Copilot Chat → model selector → select model → "Enable"

### Cursor Subscription (`cursor-not-cloud`)

`cursor-not-cloud/cursor-grok-4.6-high` uses your Cursor subscription directly through Cursor's native AgentService
endpoint at `https://api2.cursor.sh`. It is separate from the `cursor` Cloud Agents provider and never launches or
shells out to the Cursor executable.

Authenticate with `/login`. Prime can read the official Cursor auth file **read-only** (override its path with
`CURSOR_AGENT_AUTH_FILE`) or complete Cursor's browser PKCE flow. Prime imports only the access token; it never
copies the official refresh token or rewrites the official file. Browser login does not retain an unusable refresh
secret. For non-interactive use, set `CURSOR_AGENT_TOKEN` or `CURSOR_ACCESS_TOKEN`; `CURSOR_TOKEN` and cloud-only
`CURSOR_API_KEY` are intentionally not accepted.

The tray fetches the active account email through Cursor's authenticated `GetMe` RPC and binds it to the exact
credential fingerprint. Safe fallbacks are a matching official cached email, a shortened stable auth ID, then
`Cursor subscription`. The full email appears only in the local tray and is not logged.

Cursor reasoning is sibling-model routing. Grok 4.6 exposes `low`, `medium`, `high` (the default), and `xhigh`;
`max` clamps to `xhigh`:

| Prime request | Resolved level | Normal route | Fast route |
|---|---|---|---|
| `off`, `minimal`, `low` | `low` | `cursor-grok-4.6-low` | `cursor-grok-4.6-low-fast` |
| `medium` | `medium` | `cursor-grok-4.6-medium` | `cursor-grok-4.6-medium-fast` |
| `high` | `high` | `cursor-grok-4.6-high` | `cursor-grok-4.6-high-fast` |
| `xhigh`, `max` | `xhigh` | `cursor-grok-4.6-xhigh` | `cursor-grok-4.6-xhigh-fast` |

`/fast` selects the matching `-fast` sibling; it does not send a service-tier field. RLM children use the normal
omitted/inherit, `fast=true`, and `fast=false` rules. Explicit `null` is invalid. Live discovery validates the final
normal or fast route for the active credential and returns a capability error instead of silently substituting.

Conversation checkpoints and blobs are bounded, credential/base-URL isolated, and process-local. A restart starts
a new remote conversation, but Prime reconstructs the request from the persisted local transcript, including paired
tool calls/results. Current checkpoints report a 256,000-token context ceiling. The catalog's 64,000 `maxTokens` is
a conservative local fallback and is not sent as a Cursor server output limit.

Token costs shown by Prime are estimates, not Cursor subscription invoices. Grok 4.6 is normal `$2/M` input,
`$0.50/M` cached input, and `$6/M` output, or fast `$4/M` input, `$1/M` cached input, and `$12/M` output.

## API Keys

### Environment Variables or Auth File

Use `/login` in interactive mode and select a provider to store an API key in `auth.json`, or set credentials via environment variable:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
prime-agent
```

| Provider | Environment Variable | `auth.json` key |
|----------|----------------------|------------------|
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic` |
| Azure OpenAI Responses | `AZURE_OPENAI_API_KEY` | `azure-openai-responses` |
| OpenAI | `OPENAI_API_KEY` | `openai` |
| Prime Inference | `PRIME_API_KEY` | `prime-inference` |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek` |
| Google Gemini | `GEMINI_API_KEY` | `google` |
| Mistral | `MISTRAL_API_KEY` | `mistral` |
| Groq | `GROQ_API_KEY` | `groq` |
| Cerebras | `CEREBRAS_API_KEY` | `cerebras` |
| Cloudflare AI Gateway | `CLOUDFLARE_API_KEY` (+ `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_GATEWAY_ID`) | `cloudflare-ai-gateway` |
| Cloudflare Workers AI | `CLOUDFLARE_API_KEY` (+ `CLOUDFLARE_ACCOUNT_ID`) | `cloudflare-workers-ai` |
| xAI | `XAI_API_KEY` | `xai` |
| OpenRouter | `OPENROUTER_API_KEY` | `openrouter` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` | `vercel-ai-gateway` |
| ZAI | `ZAI_API_KEY` | `zai` |
| OpenCode Zen | `OPENCODE_API_KEY` | `opencode` |
| OpenCode Go | `OPENCODE_API_KEY` | `opencode-go` |
| Hugging Face | `HF_TOKEN` | `huggingface` |
| Fireworks | `FIREWORKS_API_KEY` | `fireworks` |
| Kimi For Coding | `KIMI_API_KEY` | `kimi-coding` |
| Cursor Subscription | `CURSOR_AGENT_TOKEN` or `CURSOR_ACCESS_TOKEN` | `cursor-not-cloud` |
| Cursor (Cloud Agents) | `CURSOR_API_KEY` | `cursor` |
| MiniMax | `MINIMAX_API_KEY` | `minimax` |
| MiniMax (China) | `MINIMAX_CN_API_KEY` | `minimax-cn` |
| Xiaomi MiMo | `XIAOMI_API_KEY` | `xiaomi` |
| Xiaomi MiMo Token Plan (China) | `XIAOMI_TOKEN_PLAN_CN_API_KEY` | `xiaomi-token-plan-cn` |
| Xiaomi MiMo Token Plan (Amsterdam) | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` | `xiaomi-token-plan-ams` |
| Xiaomi MiMo Token Plan (Singapore) | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` | `xiaomi-token-plan-sgp` |

Reference for environment variables and `auth.json` keys: [`env-api-keys.ts`](../../ai/src/env-api-keys.ts).

#### Auth File

Store credentials in `~/.prime/agent/auth.json`:

```json
{
  "anthropic": { "type": "api_key", "key": "sk-ant-..." },
  "openai": { "type": "api_key", "key": "sk-..." },
  "prime-inference": { "type": "api_key", "key": "..." },
  "deepseek": { "type": "api_key", "key": "sk-..." },
  "google": { "type": "api_key", "key": "..." },
  "opencode": { "type": "api_key", "key": "..." },
  "opencode-go": { "type": "api_key", "key": "..." },
  "xiaomi": { "type": "api_key", "key": "..." },
  "xiaomi-token-plan-cn":  { "type": "api_key", "key": "..." },
  "xiaomi-token-plan-ams": { "type": "api_key", "key": "..." },
  "xiaomi-token-plan-sgp": { "type": "api_key", "key": "..." }
}
```

The file is created with `0600` permissions (user read/write only). Auth file credentials take priority over environment variables.

### Key Resolution

The `key` field supports three formats:

- **Shell command:** `"!command"` executes and uses stdout (cached for process lifetime)
  ```json
  { "type": "api_key", "key": "!security find-generic-password -ws 'anthropic'" }
  { "type": "api_key", "key": "!op read 'op://vault/item/credential'" }
  ```
- **Environment variable:** Uses the value of the named variable
  ```json
  { "type": "api_key", "key": "MY_ANTHROPIC_KEY" }
  ```
- **Literal value:** Used directly
  ```json
  { "type": "api_key", "key": "sk-ant-..." }
  ```

OAuth credentials are also stored here after `/login` and managed automatically.

### Prime Inference

Prime Inference uses the OpenAI-compatible endpoint at `https://api.pinference.ai/api/v1`. Set `PRIME_API_KEY` or store an API key for `prime-inference` via `/login`.

## Cloud Providers

### Azure OpenAI

```bash
export AZURE_OPENAI_API_KEY=...
export AZURE_OPENAI_BASE_URL=https://your-resource.openai.azure.com
# also supported: https://your-resource.cognitiveservices.azure.com
# root endpoints are auto-normalized to /openai/v1
# or use resource name instead of base URL
export AZURE_OPENAI_RESOURCE_NAME=your-resource

# Optional
export AZURE_OPENAI_API_VERSION=2024-02-01
export AZURE_OPENAI_DEPLOYMENT_NAME_MAP=gpt-4=my-gpt4,gpt-4o=my-gpt4o
```

### Amazon Bedrock

```bash
# Option 1: AWS Profile
export AWS_PROFILE=your-profile

# Option 2: IAM Keys
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...

# Option 3: Bearer Token
export AWS_BEARER_TOKEN_BEDROCK=...

# Optional region (defaults to us-east-1)
export AWS_REGION=us-west-2
```

Also supports ECS task roles (`AWS_CONTAINER_CREDENTIALS_*`) and IRSA (`AWS_WEB_IDENTITY_TOKEN_FILE`).

```bash
prime-agent --provider amazon-bedrock --model us.anthropic.claude-sonnet-4-20250514-v1:0
```

Prompt caching is enabled automatically for Claude models whose ID contains a recognizable model name (base models and system-defined inference profiles). For application inference profiles (whose ARNs don't contain the model name), set `AWS_BEDROCK_FORCE_CACHE=1` to enable cache points:

```bash
export AWS_BEDROCK_FORCE_CACHE=1
prime-agent --provider amazon-bedrock --model arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123
```

If you are connecting to a Bedrock API proxy, the following environment variables can be used:

```bash
# Set the URL for the Bedrock proxy (standard AWS SDK env var)
export AWS_ENDPOINT_URL_BEDROCK_RUNTIME=https://my.corp.proxy/bedrock

# Set if your proxy does not require authentication
export AWS_BEDROCK_SKIP_AUTH=1

# Set if your proxy only supports HTTP/1.1
export AWS_BEDROCK_FORCE_HTTP1=1
```

### Cloudflare AI Gateway

`CLOUDFLARE_API_KEY` can be set via `/login`. The account ID and gateway slug must be set as environment variables.

```bash
export CLOUDFLARE_API_KEY=...           # or use /login
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_GATEWAY_ID=...        # create at dash.cloudflare.com → AI → AI Gateway
prime-agent --provider cloudflare-ai-gateway --model "claude-sonnet-4-5"
```

Routes to OpenAI, Anthropic, and Workers AI through Cloudflare AI Gateway. Workers AI uses the Unified API (`/compat`) and prefixed model IDs (`workers-ai/@cf/...`). OpenAI uses the OpenAI passthrough route (`/openai`) with native OpenAI model IDs such as `gpt-5.1`. Anthropic uses the Anthropic passthrough route (`/anthropic`) with native Anthropic model IDs such as `claude-sonnet-4-5`.

AI Gateway authentication uses `CLOUDFLARE_API_KEY` as `cf-aig-authorization`. Upstream authentication can be one of:

| Mode | Request auth | Upstream auth |
|------|--------------|---------------|
| Workers AI | Cloudflare token only | Cloudflare-native |
| Unified billing | Cloudflare token only | Cloudflare handles upstream auth and deducts credits |
| Stored BYOK | Cloudflare token only | Cloudflare injects provider keys stored in the AI Gateway dashboard |
| Inline BYOK | Cloudflare token plus upstream `Authorization` header | The request supplies the upstream provider key |

For normal Prime Agent usage, prefer unified billing or stored BYOK. Inline BYOK requires configuring an additional upstream `Authorization` header for the Cloudflare AI Gateway provider, for example via a `models.json` provider/model override.

### Cloudflare Workers AI

`CLOUDFLARE_API_KEY` can be set via `/login`. `CLOUDFLARE_ACCOUNT_ID` must be set as an environment variable.

```bash
export CLOUDFLARE_API_KEY=...           # or use /login
export CLOUDFLARE_ACCOUNT_ID=...
prime-agent --provider cloudflare-workers-ai --model "@cf/moonshotai/kimi-k2.6"
```

Prime Agent automatically sets `x-session-affinity` for [prefix caching](https://developers.cloudflare.com/workers-ai/features/prompt-caching/) discounts.

### Google Vertex AI

Uses Application Default Credentials:

```bash
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT=your-project
export GOOGLE_CLOUD_LOCATION=us-central1
```

Or set `GOOGLE_APPLICATION_CREDENTIALS` to a service account key file.

### Cursor Cloud Agents (cloud RLM target)

The `cursor` provider does not call a model endpoint. Each completion spawns (or resumes) a [Cursor cloud agent](https://cursor.com/docs/cloud-agent) run on a Cursor-hosted VM, and the agent's streamed reply is returned as the completion. No `/login`; the key comes from the environment:

```bash
export CURSOR_API_KEY=...                              # cursor.com/dashboard/api
export CURSOR_CLOUD_REPO=https://github.com/org/repo   # repo(s) cloned into the cloud VM
prime-agent --provider cursor --model cloud-agent
```

Logical model ids: `cloud-agent` (default; uses the account's server-resolved model), `composer-2.5`, `auto`.

| Variable | Purpose |
|----------|---------|
| `CURSOR_API_KEY` | Cursor user or service-account API key (required) |
| `CURSOR_CLOUD_REPO` | Full GitHub URL of the repo to run agents against (required for new agents) |
| `CURSOR_CLOUD_REPOS` | Comma-separated alternative to `CURSOR_CLOUD_REPO` for multi-repo agents |
| `CURSOR_CLOUD_TUNNEL` | `0` disables the tunnel preamble prepended to the first prompt of new agents (default: on) |
| `TAILSCALE_AUTHKEY` | Forwarded into the cloud VM so the tunnel preamble can run `tailscale up` non-interactively |

Notes:

- New agents are instructed (via the injected preamble, see `CURSOR_TUNNEL_PREAMBLE` in `packages/ai/src/providers/cursor/tunnel-preamble.ts`) to bring up Tailscale in userspace mode (`localhost:1054` HTTP / `localhost:1055` SOCKS5 proxies) plus an OpenSSH fallback, and to report their `tailscale ip4`.
- Within a session, follow-up turns automatically continue the cloud agent created on the first turn. To resume a specific agent across sessions, pass its `bc-...` id via provider options (`agentId`) or stream metadata (`metadata.cursorAgentId`). The spawned agent id and run id are exposed on each assistant message as `responseId` in the form `bc-.../run-...`; record the `bc-...` id if you need to resume later.
- The cloud agent runs its own harness with its own tools; the local system prompt and tool definitions are not forwarded.

## Custom Providers

**Via models.json:** Add Ollama, LM Studio, vLLM, or any provider that speaks a supported API (OpenAI Completions, OpenAI Responses, Anthropic Messages, Google Generative AI). See [models.md](models.md).

**Via extensions:** For providers that need custom API implementations or OAuth flows, create an extension. See [custom-provider.md](custom-provider.md) and [examples/extensions/custom-provider-gitlab-duo](../examples/extensions/custom-provider-gitlab-duo/).

## Resolution Order

When resolving credentials for a provider:

1. CLI `--api-key` flag
2. `auth.json` entry (API key or OAuth token)
3. Environment variable
4. Custom provider keys from `models.json`
