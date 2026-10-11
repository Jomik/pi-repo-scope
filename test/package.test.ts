import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as entry from "../src/index.js";

function readJson(path: string) {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
}

const packageJson = readJson("../package.json");

describe("standalone package scaffold", () => {
  it("publishes only the built ESM boundary without a resolver API or runtime dependencies", () => {
    expect(packageJson.name).toBe("pi-repo-scope");
    expect(packageJson.version).toBe("0.1.0");
    expect(packageJson.type).toBe("module");
    expect(packageJson.exports).toEqual({
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
    });
    expect(packageJson.files).toEqual(["dist"]);
    expect(packageJson.dependencies ?? {}).toEqual({});
    expect(packageJson.peerDependencies ?? {}).toEqual({});
    expect(packageJson.pi).toBeUndefined();
    expect(Object.keys(entry)).toEqual([]);
  });

  it("uses the specified Node and development tooling", () => {
    expect(packageJson.engines).toEqual({ node: ">=24" });
    expect(packageJson.packageManager).toBe("npm@11.12.1");
    expect(readFileSync(new URL("../.node-version", import.meta.url), "utf8").trim()).toBe("24");
    expect(packageJson.devDependencies).toEqual({
      "@biomejs/biome": "^2.5.14",
      "@types/node": "^24.0.0",
      typescript: "^6.0.3",
      vitest: "^4.1.11",
    });
    expect(packageJson.scripts).toEqual({
      build: "tsc -p tsconfig.build.json",
      prepack: "npm run build",
      typecheck: "tsc --noEmit",
      lint: "biome check",
      "lint:fix": "biome check --write",
      format: "biome format --write",
      test: "vitest run",
    });
  });

  it("builds declarations from source only and excludes generated and orchestration files", () => {
    const tsconfig = readJson("../tsconfig.json");
    const build = readJson("../tsconfig.build.json");
    const biome = readJson("../biome.json");

    expect(tsconfig.compilerOptions).toMatchObject({
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
    });
    expect(tsconfig.include).toEqual(["src/**/*.ts", "test/**/*.ts"]);
    expect(build.extends).toBe("./tsconfig.json");
    expect(build.compilerOptions).toEqual({
      noEmit: false,
      declaration: true,
      rootDir: "src",
      outDir: "dist",
    });
    expect(build.include).toEqual(["src/**/*.ts"]);
    expect(biome.files.includes).toEqual(["**", "!!**/dist", "!!**/node_modules", "!!**/.pi"]);
    expect(biome.formatter).toMatchObject({ indentStyle: "space", indentWidth: 2, lineWidth: 120 });
    expect(biome.javascript.formatter.quoteStyle).toBe("double");
    expect(biome.linter.rules).toEqual({ preset: "recommended" });
    expect(biome.assist.actions.source.organizeImports).toBe("on");
    expect(readFileSync(new URL("../.gitignore", import.meta.url), "utf8").split("\n")).toEqual([
      "/dist/",
      "/node_modules/",
      "/.pi/",
      "",
    ]);
  });
});
