import { describe, expect, test } from "bun:test";
import { supportedConvexNodeEnv } from "../src/tools/node-runtime";

describe("supportedConvexNodeEnv", () => {
  test("keeps the current environment when PATH node is supported", () => {
    const base = { PATH: "/usr/bin" };
    const env = supportedConvexNodeEnv(base, {
      nodeMajor: (command) => (command === "node" ? 22 : null),
      exists: () => {
        throw new Error("must not probe when PATH already qualifies");
      },
    });
    expect(env).toBe(base);
  });

  test("prepends the newest supported Homebrew node when PATH node is unsupported", () => {
    const base = { PATH: "/usr/bin" };
    const env = supportedConvexNodeEnv(base, {
      nodeMajor: (command) =>
        command === "node" ? 26 : command === "/opt/homebrew/opt/node@22/bin/node" ? 22 : null,
      exists: (path) => path === "/opt/homebrew/opt/node@22/bin/node",
      list: () => [],
      home: () => "/nonexistent",
    });
    expect(env.PATH).toBe("/opt/homebrew/opt/node@22/bin:/usr/bin");
    expect(base.PATH).toBe("/usr/bin");
  });

  test("finds a supported version-manager install, newest supported major first", () => {
    const home = "/home/operator";
    const nvmBin = `${home}/.nvm/versions/node/v24.1.0/bin`;
    const env = supportedConvexNodeEnv(
      { PATH: "/usr/bin" },
      {
        nodeMajor: (command) =>
          command === "node" ? null : command === `${nvmBin}/node` ? 24 : null,
        exists: (path) => path === `${nvmBin}/node`,
        list: (directory) =>
          directory === `${home}/.nvm/versions/node` ? ["v26.0.0", "v24.1.0", "v18.19.0"] : [],
        home: () => home,
      },
    );
    expect(env.PATH).toBe(`${nvmBin}:/usr/bin`);
  });

  test("throws actionable guidance when no supported node exists", () => {
    expect(() =>
      supportedConvexNodeEnv(
        { PATH: "/usr/bin" },
        {
          nodeMajor: (command) => (command === "node" ? 26 : null),
          exists: () => false,
          list: () => [],
          home: () => "/nonexistent",
        },
      ),
    ).toThrow(/Node\.js 18, 20, 22, or 24.*found v26/s);
  });
});
