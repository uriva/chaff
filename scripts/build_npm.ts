import { build, emptyDir } from "@deno/dnt";
import denoJson from "../deno.json" with { type: "json" };

const outDir = "./npm";
await emptyDir(outDir);

await build({
  entryPoints: ["./mod.ts"],
  outDir,
  importMap: "./deno.json",
  shims: {},
  scriptModule: false,
  test: false,
  typeCheck: "both",
  compilerOptions: {
    lib: ["ESNext", "DOM"],
    target: "Latest",
  },
  package: {
    name: "chaff",
    version: denoJson.version,
    description:
      "Multi-party, time-aware AI agent harness for IM and real-time voice. Economical, dynamic, zero knobs.",
    license: denoJson.license,
    homepage: "https://chaff.uriv.me",
    repository: {
      type: "git",
      url: "git+https://github.com/uriva/chaff.git",
    },
    bugs: {
      url: "https://github.com/uriva/chaff/issues",
    },
    keywords: [
      "ai",
      "agent",
      "harness",
      "llm",
      "multi-party",
      "voice",
      "messaging",
      "whatsapp",
      "telegram",
      "gemini",
      "anthropic",
      "kimi",
    ],
    engines: {
      node: ">=20",
    },
  },
  postBuild: () => {
    Deno.copyFileSync("README.md", `${outDir}/README.md`);
    const pkgPath = `${outDir}/package.json`;
    const pkg = JSON.parse(Deno.readTextFileSync(pkgPath));
    pkg.types = "./esm/mod.d.ts";
    pkg.exports = {
      ".": {
        types: "./esm/mod.d.ts",
        import: "./esm/mod.js",
        default: "./esm/mod.js",
      },
    };
    if (pkg.dependencies && typeof pkg.dependencies === "object") {
      pkg.dependencies = Object.fromEntries(
        Object.entries(pkg.dependencies).map(([name, version]) => [
          name,
          typeof version === "string" && /^\d/.test(version)
            ? `^${version}`
            : version,
        ]),
      );
    }
    Deno.writeTextFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  },
});
