# cpa-provider

[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) provider extension for [pi](https://pi.dev).

The extension reads the OpenAI-compatible `/v1/models` endpoint, registers the returned models in pi, and enriches known model IDs with context limits, reasoning support, image input, and output limits from the pi.dev model catalog.

## Install

```bash
pi install npm:cpa-provider
```

Git installs are also supported:

```bash
pi install https://github.com/gcoder1991/cpa-provider
```

Restart pi, then configure the provider:

```text
/login cpa
```

Enter the API key configured in CLIProxyAPI. Use `/model` to select a discovered model.

## Configuration

The default CLIProxyAPI endpoint is:

```text
http://127.0.0.1:8317
```

Override it before starting pi:

```bash
CPA_BASE_URL=http://127.0.0.1:8317 pi
```

For non-interactive authentication:

```bash
CPA_API_KEY=your-api-key pi
```

Both variables can be used together:

```bash
CPA_BASE_URL=https://cpa.example.com CPA_API_KEY=your-api-key pi
```

## Fast mode

Toggle OpenAI Fast mode for CPA requests:

```text
/cpa-fast on
/cpa-fast off
/cpa-fast status
/cpa-info
```

To enable it at startup:

```bash
CPA_FAST_MODE=1 pi
```

Fast mode sends `service_tier: "priority"`, the backward-compatible name for OpenAI Fast mode. OpenAI/Codex text models use `/v1/responses`; other discovered models keep `/v1/chat/completions`.

## Model metadata

`/v1/models` normally returns model IDs but not capability metadata. Known IDs are matched against pi.dev catalogs for:

- context window
- maximum output tokens
- reasoning support
- image input support
- pricing metadata

Unknown IDs remain available with conservative defaults: 128K context, 16K maximum output, text-only input, and reasoning disabled.

## Update

```bash
pi update --extensions
```

## Remove

```bash
pi remove npm:cpa-provider
```
