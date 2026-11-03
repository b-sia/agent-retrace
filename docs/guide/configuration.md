# Configuration: `configure()`

Call `configure()` once, for example in a Vitest setup file.

```ts
import { configure } from "agent-retrace";

configure({
  providerHosts: ["my-gateway.example.com", "127.0.0.1:4010"],
  ignore: ["metadata", "messages.*.cache_control"],
  redact: [/cust_[a-z0-9]+/g, (value) => value.replaceAll("alice@example.com", "<email>")],
});
```

## Provider hosts

Calls to `api.openai.com` and `api.anthropic.com` are recorded and replayed by default. Hosts you add are treated exactly the same; entries are `host` or `host:port`, with no scheme or path. A host without a port matches it on any port.

> [!IMPORTANT]
> **If your client uses a custom `baseURL`** (Azure OpenAI, a corporate proxy, an LLM gateway, a local fake), **add its host to `providerHosts`.** Otherwise its calls are neither recorded nor replayed, and in CI they are not blocked: they go to the network like any other traffic.

## Redaction

API keys and auth headers (`authorization`, `x-api-key`, cookies and similar) are always stripped, and any API key from your environment is scrubbed wherever it appears. `redact` adds your own rules: a `RegExp` whose matches are replaced, or a function from a string to its redacted form. Rules apply to every string in provider requests and responses and in tool arguments, results and errors, before anything is written to disk.

Redaction also applies to matching: the live request is redacted the same way before it is compared with the recording, so a redacted value that differs between runs does not count as a change.

## Ignored fields

Some request fields vary from run to run without meaning anything, such as a user ID in `metadata` or cache hints. `ignore` takes request body paths that are left out of matching: dot-separated keys, with `*` for any array index or key, e.g. `messages.*.cache_control`.

Headers need no rules: only `anthropic-version`, `anthropic-beta` and `openai-beta` are stored and matched, so request IDs, SDK version headers and the like never count as a change.
