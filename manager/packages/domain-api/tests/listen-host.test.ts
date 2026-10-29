import { expect, test } from "vitest";
import { ConfigError, loadListenHost } from "../src/config.js";

test("LISTEN_HOST unset or empty keeps the default bind (undefined)", () => {
  expect(loadListenHost({})).toBeUndefined();
  expect(loadListenHost({ LISTEN_HOST: "" })).toBeUndefined();
});

test("LISTEN_HOST accepts IP literals and DNS names", () => {
  expect(loadListenHost({ LISTEN_HOST: "127.0.0.1" })).toBe("127.0.0.1");
  expect(loadListenHost({ LISTEN_HOST: "::1" })).toBe("::1");
  expect(loadListenHost({ LISTEN_HOST: "localhost" })).toBe("localhost");
});

test("LISTEN_HOST rejects invalid values", () => {
  for (const LISTEN_HOST of ["http://x", "a b", "0.0.0.0:80", "-bad"]) {
    expect(() => loadListenHost({ LISTEN_HOST })).toThrow(ConfigError);
  }
});
