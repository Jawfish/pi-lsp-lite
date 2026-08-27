import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildServerStates,
  formatServerStates,
  formatStatusLine,
} from "../src/status.js";
import type { InstallEntry } from "../src/install-registry.js";
import type { LanguageServerConfig } from "../src/languages.js";
import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver-protocol";
import { visibleWidth } from "@earendil-works/pi-tui";

const builtinTs: LanguageServerConfig = {
  id: "typescript",
  extensions: [".ts"],
  command: "typescript-language-server",
  args: ["--stdio"],
  rootPatterns: ["tsconfig.json"],
};

const customLua: LanguageServerConfig = {
  id: "lua",
  extensions: [".lua"],
  command: "lua-language-server",
  args: [],
  rootPatterns: [".luarc.json"],
};

const installRegistry = new Map<string, InstallEntry>([
  ["typescript", { command: { default: "npm install -g typescript-language-server typescript" }, description: "TypeScript" }],
]);

describe("buildServerStates", () => {
  it("includes built-ins, active custom servers, and disabled global servers", async () => {
    const states = await buildServerStates({
      builtins: [builtinTs],
      active: [builtinTs, customLua],
      globalConfig: {
        servers: {
          haskell: {
            disabled: true,
            command: "haskell-language-server-wrapper",
            extensions: [".hs"],
          },
        },
      },
      running: [
        {
          id: "typescript",
          root: "/repo",
          pid: 123,
          uptime: 5_000,
          openDocuments: 2,
          lastActivity: Date.now(),
        },
      ],
      activity: [
        { id: "typescript", root: "/repo", state: "running" },
        { id: "lua", root: "/lua", state: "starting" },
      ],
      installRegistry,
      resolveCommand: async (command) => command === "typescript-language-server" ? "/bin/typescript-language-server" : null,
    });

    assert.deepEqual(states.map((s) => s.id), ["haskell", "lua", "typescript"]);

    const typescript = states.find((s) => s.id === "typescript");
    assert.ok(typescript);
    assert.equal(typescript.enabled, true);
    assert.equal(typescript.installed, true);
    assert.equal(typescript.installable, true);
    assert.equal(typescript.running.length, 1);
    assert.deepEqual(typescript.starting, []);

    const lua = states.find((s) => s.id === "lua");
    assert.ok(lua);
    assert.equal(lua.enabled, true);
    assert.equal(lua.installed, false);
    assert.equal(lua.installable, false);
    assert.deepEqual(lua.starting, ["/lua"]);

    const haskell = states.find((s) => s.id === "haskell");
    assert.ok(haskell);
    assert.equal(haskell.enabled, false);
    assert.equal(haskell.command, "haskell-language-server-wrapper");
    assert.equal(haskell.installed, false);
  });
  it("uses global command overrides when a built-in is disabled", async () => {
    const states = await buildServerStates({
      builtins: [builtinTs],
      active: [],
      globalConfig: {
        servers: {
          typescript: {
            disabled: true,
            command: "custom-typescript-language-server",
          },
        },
      },
      running: [],
      activity: [],
      installRegistry,
      resolveCommand: async (command) => command === "custom-typescript-language-server" ? "/bin/custom-typescript-language-server" : null,
    });

    const typescript = states.find((s) => s.id === "typescript");
    assert.ok(typescript);
    assert.equal(typescript.enabled, false);
    assert.equal(typescript.command, "custom-typescript-language-server");
    assert.equal(typescript.installed, true);
  });
});

describe("formatStatusLine", () => {
  it("shows sorted server glyphs and diagnostic totals", () => {
    const diagnostic = (severity: DiagnosticSeverity): Diagnostic => ({
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      },
      severity,
      message: "test",
    });
    const diagnostics = new Map([
      ["file:///one.ts", [
        diagnostic(DiagnosticSeverity.Error),
        diagnostic(DiagnosticSeverity.Warning),
        diagnostic(DiagnosticSeverity.Information),
      ]],
      ["file:///two.ts", [diagnostic(DiagnosticSeverity.Error)]],
    ]);

    const status = formatStatusLine([
      { id: "rust", root: "/rust", state: "starting" },
      { id: "go", root: "/go-one", state: "running" },
      { id: "go", root: "/go-two", state: "running" },
    ], diagnostics);

    assert.equal(status, "lsp go✓ rust⏳ 2E/1W");
  });

  it("clears when no server is active", () => {
    assert.equal(formatStatusLine([], new Map()), undefined);
  });
});

describe("formatServerStates", () => {
  it("aligns state, server, command, and install columns", () => {
    const states = [
      {
        id: "typescript",
        command: "typescript-language-server",
        enabled: true,
        installed: true,
        installable: true,
        running: [
          { id: "typescript", root: "/repo-one", pid: 123, uptime: 5_000, openDocuments: 2, lastActivity: Date.now() },
          { id: "typescript", root: "/repo-two", pid: 456, uptime: 8_000, openDocuments: 1, lastActivity: Date.now() },
        ],
        starting: [],
      },
      {
        id: "rust",
        command: "rust-analyzer",
        enabled: true,
        installed: true,
        installable: true,
        running: [],
        starting: ["/rust"],
      },
      {
        id: "lua",
        command: "lua-language-server",
        enabled: true,
        installed: false,
        installable: false,
        running: [],
        starting: [],
      },
      {
        id: "python",
        command: "pylsp",
        enabled: true,
        installed: true,
        installable: true,
        running: [],
        starting: [],
      },
    ];
    const output = formatServerStates(states);
    const topLevel = output.split("\n").filter((line) =>
      /^[✓○✗⏳]/u.test(line)
    );
    const serverOffsets = topLevel.map((line, index) =>
      visibleWidth(line.slice(0, line.indexOf(states[index].id)))
    );
    const commandOffsets = topLevel.map((line, index) =>
      visibleWidth(line.slice(0, line.indexOf(states[index].command)))
    );

    assert.equal(new Set(serverOffsets).size, 1);
    assert.equal(new Set(commandOffsets).size, 1);
    assert.match(output, /^✓\s+typescript\s+typescript-language-server\s+installed$/mu);
    assert.match(output, /^⏳\s+rust\s+rust-analyzer\s+installed$/mu);
    assert.match(output, /^✗\s+lua\s+lua-language-server\s+missing \(manual\)$/mu);
    assert.match(output, /^○\s+python\s+pylsp\s+installed$/mu);
    assert.match(output, /↳ \/repo-one  pid=123  up=5s  open=2/u);
    assert.match(output, /↳ \/repo-two  pid=456  up=8s  open=1/u);
    assert.match(output, /↳ \/rust  starting/u);
    assert.match(
      output,
      /Legend: ✓ running  ○ idle  ✗ missing  ⏳ starting/u,
    );
  });
});
