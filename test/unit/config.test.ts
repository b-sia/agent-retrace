/**
 * Tests for mode resolution and provider host configuration.
 */
import { afterEach, expect, test } from "vitest";
import {
  configure,
  getConfig,
  isProviderHost,
  resetConfig,
  resolveMode,
} from "../../src/config.js";
import { InvalidModeError, ReplayUsageError } from "../../src/errors.js";

afterEach(resetConfig);

test("explicit mode wins", () =>
  expect(resolveMode({ AGENT_RETRACE_MODE: "update", CI: "true" })).toBe("update"));
test("CI defaults to replay", () => expect(resolveMode({ CI: "1" })).toBe("replay"));
test.each(["", "0", "false", "FALSE"])("CI=%j counts as unset", (ci) =>
  expect(resolveMode({ CI: ci })).toBe("auto"),
);
test("local defaults to auto", () => expect(resolveMode({})).toBe("auto"));
test("empty mode counts as unset", () =>
  expect(resolveMode({ AGENT_RETRACE_MODE: "", CI: "1" })).toBe("replay"));
test("invalid mode throws, listing the valid values", () => {
  expect(() => resolveMode({ AGENT_RETRACE_MODE: "record" })).toThrow(InvalidModeError);
  expect(() => resolveMode({ AGENT_RETRACE_MODE: "record" })).toThrow(/replay.*auto.*update/);
});

test("default provider hosts", () => {
  expect(isProviderHost(new URL("https://api.openai.com/v1/x"))).toBe(true);
  expect(isProviderHost(new URL("https://API.Anthropic.com/v1/messages"))).toBe(true);
  expect(isProviderHost(new URL("http://localhost:3000/"))).toBe(false);
});

test("configured hosts are additive and match host:port", () => {
  configure({ providerHosts: ["my-gw.example.com", "127.0.0.1:4010"] });
  expect(isProviderHost(new URL("https://my-gw.example.com/v1"))).toBe(true);
  expect(isProviderHost(new URL("http://127.0.0.1:4010/v1"))).toBe(true);
  expect(isProviderHost(new URL("http://127.0.0.1:4011/v1"))).toBe(false);
  expect(isProviderHost(new URL("https://api.openai.com/"))).toBe(true);
});

test.each<[string[], string, boolean]>([
  [["My-GW.example.com"], "https://my-gw.example.com:8443/v1", true],
  [["gw.example.com:443"], "https://gw.example.com/v1", true],
  [["gw.example.com:80"], "http://gw.example.com/v1", true],
  [["gw.example.com:443"], "http://gw.example.com/v1", false],
  [["gw.example.com:443"], "https://gw.example.com:8443/v1", false],
  [[], "https://api.openai.com./v1", true],
  [[], "https://api.openai.com.:443/v1", true],
])("with entries %j, %s is a provider host: %s", (entries, url, expected) => {
  configure({ providerHosts: entries });
  expect(isProviderHost(new URL(url))).toBe(expected);
});

test("entries are trimmed and a trailing dot is dropped", () => {
  configure({ providerHosts: ["  gw.example.com.\n", "[::1]:4010"] });
  expect(getConfig().providerHosts).toEqual([
    "api.openai.com",
    "api.anthropic.com",
    "gw.example.com",
    "[::1]:4010",
  ]);
  expect(isProviderHost(new URL("http://[::1]:4010/v1"))).toBe(true);
});

test.each([
  "https://gw.example.com",
  "gw.example.com/v1",
  "gw.example.com?x=1",
  "user@gw.example.com",
  "gw example.com",
  "gw.example.com:abc",
  "",
  "   ",
])("invalid provider host %j is rejected", (entry) => {
  expect(() => configure({ providerHosts: [entry] })).toThrow(ReplayUsageError);
  expect(() => configure({ providerHosts: [entry] })).toThrow(/host:port/);
});

test("a rejected configure call keeps the previous config", () => {
  configure({ providerHosts: ["a.example"] });
  expect(() => configure({ providerHosts: ["https://b.example"] })).toThrow(ReplayUsageError);
  expect(getConfig().providerHosts).toContain("a.example");
});

test("config arrays are read-only", () => {
  const config = getConfig();
  // @ts-expect-error providerHosts is readonly
  expect(() => config.providerHosts.push("x.example")).toThrow(TypeError);
  // @ts-expect-error ignore is readonly
  expect(() => config.ignore.push("x")).toThrow(TypeError);
});

test("configure replaces previous user values", () => {
  configure({ providerHosts: ["a.example"] });
  configure({ providerHosts: ["b.example"] });
  expect(getConfig().providerHosts).toEqual(["api.openai.com", "api.anthropic.com", "b.example"]);
});

test("provider hosts are lowercased and deduped", () => {
  configure({ providerHosts: ["API.OPENAI.COM", "x.example", "X.example"] });
  expect(getConfig().providerHosts).toEqual(["api.openai.com", "api.anthropic.com", "x.example"]);
});

test("configure sets ignore and redact, and resetConfig clears them", () => {
  const rule = /sk-[a-z]+/g;
  configure({ ignore: ["metadata"], redact: [rule] });
  expect(getConfig().ignore).toEqual(["metadata"]);
  expect(getConfig().redact).toEqual([rule]);
  resetConfig();
  expect(getConfig()).toEqual({
    providerHosts: ["api.openai.com", "api.anthropic.com"],
    ignore: [],
    redact: [],
  });
});
