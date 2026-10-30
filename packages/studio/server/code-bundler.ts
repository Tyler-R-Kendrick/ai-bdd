import { context, type Loader, type Message, type Plugin } from "esbuild";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkCodeProject,
  executableFile,
  projectPath,
  resolveProjectFile,
  type CodeProject,
} from "../shared/code-project.ts";
import {
  buildPreviewDocument,
  parsePreviewContracts,
} from "../shared/preview.ts";

const require = createRequire(import.meta.url);
const resolveDir = dirname(fileURLToPath(import.meta.url));
const browserPackages = [
  "react",
  "react-dom",
  "lucide-react",
  "clsx",
  "tailwind-merge",
  "zod",
  "three",
  "@json-render/core",
  "@json-render/react",
  "@openuidev/react-lang",
  "@radix-ui/react-dialog",
  "@radix-ui/react-dropdown-menu",
  "@radix-ui/react-select",
  "@radix-ui/react-tabs",
  "@radix-ui/react-tooltip",
  "@radix-ui/react-slot",
] as const;
const packageImports = new Set<string>([
  ...browserPackages,
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom/client",
]);
export type CodeDiagnostic = {
  text: string;
  file?: string;
  line?: number;
  column?: number;
  severity: "error" | "warning";
};
export class CodeBuildError extends Error {
  readonly diagnostics: CodeDiagnostic[];
  constructor(
    message: string,
    diagnostics: CodeDiagnostic[] = [{ text: message, severity: "error" }],
  ) {
    super(message);
    this.name = "CodeBuildError";
    this.diagnostics = diagnostics;
  }
}
const diagnostic = (
  message: Message,
  severity: CodeDiagnostic["severity"],
): CodeDiagnostic => ({
  text: message.text,
  severity,
  ...(message.location
    ? {
        file: message.location.file.replace(/^studio-files:/, ""),
        line: message.location.line,
        column: message.location.column + 1,
      }
    : {}),
});
export function codePreviewDependencies() {
  return browserPackages.map((name) => {
    try {
      return { name, version: String(require(name + "/package.json").version) };
    } catch {
      // Packages with restrictive exports still have a bounded installed package manifest.
      let directory = dirname(require.resolve(name));
      for (let parent = 0; parent < 5; parent++) {
        try {
          const manifest = require(directory + "/package.json");
          if (manifest.name === name)
            return { name, version: String(manifest.version) };
        } catch {}
        directory = dirname(directory);
      }
      return { name, version: "installed" };
    }
  });
}
function validateManifest(files: CodeProject["files"]) {
  if (!files["package.json"]) return;
  let manifest: any;
  try {
    manifest = JSON.parse(files["package.json"]);
  } catch {
    throw new CodeBuildError("package.json must contain valid JSON");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    throw new CodeBuildError("package.json must be an object");
  const available = new Map(
    codePreviewDependencies().map((value) => [
      value.name as string,
      value.version,
    ]),
  );
  for (const field of ["dependencies", "devDependencies"]) {
    if (!manifest[field]) continue;
    if (typeof manifest[field] !== "object" || Array.isArray(manifest[field]))
      throw new CodeBuildError(`package.json ${field} must be an object`);
    for (const [name, range] of Object.entries(manifest[field])) {
      if (!available.has(name))
        throw new CodeBuildError(
          `${name} is not installed for browser previews. Choose an installed package from Packages; install scripts and arbitrary packages are not executed.`,
        );
      const version = available.get(name)!;
      if (
        typeof range !== "string" ||
        !/^(?:\*|latest|[~^]?\d+(?:\.\d+|\.\*){0,2}(?:-[\w.-]+)?)$/.test(range)
      )
        throw new CodeBuildError(
          `Use an exact version, ^ or ~ range for ${name}`,
        );
      if (range === "*" || range === "latest" || version === "installed")
        continue;
      const wanted = range.replace(/^[~^]/, "").split("."),
        actual = version.split(".");
      const lower = wanted.map((part) => (part === "*" ? 0 : Number(part)));
      while (lower.length < 3) lower.push(0);
      const actualNumbers = actual.map((part) => Number(part.split("-")[0]));
      const atLeast =
        actualNumbers[0]! > lower[0]! ||
        (actualNumbers[0] === lower[0] &&
          (actualNumbers[1]! > lower[1]! ||
            (actualNumbers[1] === lower[1] && actualNumbers[2]! >= lower[2]!)));
      const valid =
        atLeast &&
        wanted.every(
          (part, index) =>
            part === "*" ||
            (range.startsWith("^") && index > (wanted[0] === "0" ? 1 : 0)) ||
            (range.startsWith("~") && index > 1) ||
            Number(actual[index]) === Number(part),
        );
      if (!valid)
        throw new CodeBuildError(
          `${name} ${range} is unavailable; this workspace installs ${version}. Update package.json to use the installed version.`,
        );
    }
  }
}
function loader(path: string): Loader {
  const extension = path.split(".").pop()?.toLowerCase();
  if (
    extension === "tsx" ||
    extension === "jsx" ||
    extension === "ts" ||
    extension === "json" ||
    extension === "css"
  )
    return extension;
  if (
    ["svg", "png", "jpg", "jpeg", "gif", "webp", "woff", "woff2"].includes(
      extension ?? "",
    )
  )
    return "dataurl";
  return "js";
}
function assetDataUrl(path: string, source: string) {
  if (/\.svg$/i.test(path))
    return (
      "data:image/svg+xml;base64," + Buffer.from(source).toString("base64")
    );
  if (
    /^data:(?:image\/(?:png|jpeg|gif|webp)|font\/(?:woff2?|ttf));base64,[A-Za-z0-9+/]*={0,2}$/.test(
      source,
    )
  )
    return source;
  throw new CodeBuildError(
    `Binary asset ${path} must contain a base64 data URL; SVG files can contain their original source`,
  );
}
const attribute = (attributes: string, name: string) => {
  const match = new RegExp(
    "(?:^|\\s)" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))",
    "i",
  ).exec(attributes);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : undefined;
};
function htmlInputs(project: CodeProject) {
  const sources: string[] = [],
    virtual = { ...project.files },
    used = new Set<string>();
  let sequence = 0;
  let html = project.files[project.entry]!;
  let legacyHtml = html;
  let moduleScripts = false;
  const local = (reference: string) => {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference))
      throw new CodeBuildError(
        "Preview dependencies must be local files or installed packages; remote script/style URLs are blocked",
      );
    const path = projectPath(project.entry, reference.split(/[?#]/)[0]!);
    if (!path || !Object.hasOwn(project.files, path))
      throw new CodeBuildError(
        `Referenced file ${reference} is missing from this artifact`,
      );
    return path;
  };
  html = html.replace(
    /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi,
    (whole, attrs: string, source: string) => {
      const type = attribute(attrs, "type") ?? "";
      if (
        type &&
        ![
          "module",
          "text/javascript",
          "application/javascript",
          "text/babel",
          "text/tsx",
        ].includes(type.toLowerCase())
      )
        return whole;
      if (["module", "text/tsx", "text/babel"].includes(type))
        moduleScripts = true;
      const src = attribute(attrs, "src");
      if (src) {
        const path = local(src);
        used.add(path);
        sources.push(path);
      } else if (source.trim()) {
        const path = `${project.entry.split('/').slice(0, -1).join('/')}${project.entry.includes('/') ? '/' : ''}__studio_inline_${sequence++}.${type === 'text/tsx' || type === 'text/babel' ? 'tsx' : 'js'}`;
        virtual[path] = source;
        sources.push(path);
      }
      return "";
    },
  );
  html = html.replace(/<link\b([^>]*?)\/?\s*>/gi, (whole, attrs: string) => {
    if (attribute(attrs, "rel")?.toLowerCase() !== "stylesheet") return whole;
    const href = attribute(attrs, "href");
    if (href) {
      const path = local(href);
      used.add(path);
      sources.push(path);
    }
    return "";
  });
  html = html.replace(
    /(<(?:img|source)\b[^>]*?\bsrc\s*=\s*)(["'])([^"']+)\2/gi,
    (whole, prefix, quote, reference) => {
      if (/^(?:data:|blob:)/i.test(reference)) return whole;
      const path = local(reference);
      return prefix + quote + assetDataUrl(path, project.files[path]!) + quote;
    },
  );
  const explicitScripts = sources.some(executableFile);
  // Preserve the original zero-configuration HTML/CSS/JS project format.
  for (const path of Object.keys(project.files))
    if (
      !used.has(path) &&
      (/\.css$/i.test(path) || (/\.js$/i.test(path) && !explicitScripts))
    )
      sources.push(path);
  legacyHtml = legacyHtml
    .replace(
      /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi,
      (whole, attrs: string, _source: string) => {
        const src = attribute(attrs, "src");
        if (!src) return whole;
        return (
          "<script>" +
          project.files[local(src)]!.replace(/<\/script/gi, "<\\/script") +
          "</script>"
        );
      },
    )
    .replace(/<link\b([^>]*?)\/?\s*>/gi, (whole, attrs: string) =>
      attribute(attrs, "rel")?.toLowerCase() === "stylesheet" ? "" : whole,
    );
  const legacyMode =
    !moduleScripts &&
    !sources.some(
      (path) =>
        /\.[jt]sx?$/.test(path) &&
        (/\.(?:jsx|tsx?)$/.test(path) ||
          /\b(?:import|export)\s|\brequire\s*\(/.test(virtual[path]!)),
    );
  return { html, virtual, sources, legacyMode, legacyHtml, used };
}
let activeBuilds = 0;
/** Compile an in-memory project. Authored code is never evaluated by Node or written to disk. */
export async function compileCodePreview(
  input: CodeProject & { channel: string },
) {
  if (activeBuilds >= 2)
    throw new CodeBuildError(
      "Two previews are compiling. Try again in a moment.",
    );
  activeBuilds++;
  try {
    try {
      checkCodeProject(input);
      parsePreviewContracts(input.files["contracts.json"]);
      validateManifest(input.files);
    } catch (error) {
      throw error instanceof CodeBuildError
        ? error
        : new CodeBuildError((error as Error).message);
    }
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(input.channel))
      throw new CodeBuildError("Invalid preview message channel");
    const isHtml = /\.html?$/i.test(input.entry);
    const prepared = isHtml
      ? htmlInputs(input)
      : {
          html: '<div id="root"></div>',
          virtual: { ...input.files },
          sources: [input.entry],
          legacyMode: false,
          legacyHtml: "",
          used: new Set<string>(),
        };
    const dependencyNames = new Set<string>(),
      loaded = new Set<string>();
    const virtual = prepared.virtual;
    const bootstrap = isHtml
      ? prepared.sources
          .map((path) => `import ${JSON.stringify("./" + path)};`)
          .join("\n")
      : `import * as entry from ${JSON.stringify("./" + input.entry)};\nimport React from 'react';\nimport {createRoot} from 'react-dom/client';\nif (entry.default) { const root = document.getElementById('root'); createRoot(root).render(React.isValidElement(entry.default) ? entry.default : React.createElement(entry.default)); }`;
    const plugin: Plugin = {
      name: "studio-virtual-project",
      setup(builder) {
        builder.onResolve(
          { filter: /.*/, namespace: "studio-entry" },
          (args) => {
            if (args.path.startsWith(".") || args.path.startsWith("/")) {
              const path = resolveProjectFile(virtual, "index.js", args.path);
              return path
                ? { path, namespace: "studio-files" }
                : { errors: [{ text: `File ${args.path} is missing` }] };
            }
            if (!packageImports.has(args.path))
              return {
                errors: [
                  {
                    text: `Package ${args.path} is unavailable. Use Packages to see installed browser dependencies.`,
                  },
                ],
              };
            dependencyNames.add(
              args.path === "react-dom/client"
                ? "react-dom"
                : args.path.startsWith("react/")
                  ? "react"
                  : args.path,
            );
            return builder.resolve(args.path, { resolveDir, kind: args.kind });
          },
        );
        builder.onResolve(
          { filter: /.*/, namespace: "studio-files" },
          (args) => {
            if (args.kind === "url-token" && args.path.startsWith("data:"))
              return { path: args.path, external: true };
            if (
              args.path.startsWith(".") ||
              args.path.startsWith("/") ||
              args.path.startsWith("@/")
            ) {
              const path = resolveProjectFile(
                virtual,
                args.importer,
                args.path.startsWith("@/")
                  ? "/src/" + args.path.slice(2)
                  : args.path,
              );
              if (
                path &&
                args.kind === "url-token" &&
                /\.(?:svg|png|jpe?g|gif|webp|woff2?|ttf)$/i.test(path)
              )
                return {
                  path: assetDataUrl(path, virtual[path]!),
                  external: true,
                };
              return path
                ? { path, namespace: "studio-files" }
                : {
                    errors: [
                      {
                        text: `File ${args.path} imported by ${args.importer} is missing or leaves the project`,
                      },
                    ],
                  };
            }
            if (!packageImports.has(args.path))
              return {
                errors: [
                  {
                    text: `Package ${args.path} is unavailable. Use Packages to see installed browser dependencies.`,
                  },
                ],
              };
            dependencyNames.add(
              args.path === "react-dom/client"
                ? "react-dom"
                : args.path.startsWith("react/")
                  ? "react"
                  : args.path,
            );
            return builder.resolve(args.path, { resolveDir, kind: args.kind });
          },
        );
        builder.onLoad({ filter: /.*/, namespace: "studio-entry" }, () => ({
          contents: bootstrap,
          loader: "tsx",
          resolveDir: "/",
        }));
        builder.onLoad({ filter: /.*/, namespace: "studio-files" }, (args) => {
          loaded.add(args.path);
          if (/\.(?:svg|png|jpe?g|gif|webp|woff2?|ttf)$/i.test(args.path))
            return {
              contents:
                "export default " +
                JSON.stringify(assetDataUrl(args.path, virtual[args.path]!)),
              loader: "js",
            };
          return {
            contents: virtual[args.path]!,
            loader: loader(args.path),
            resolveDir: "/",
          };
        });
        builder.onResolve({ filter: /^studio:entry$/ }, () => ({
          path: "entry",
          namespace: "studio-entry",
        }));
      },
    };
    let compiled;
    try {
      const compiler = await context({
        entryPoints: ["studio:entry"],
        bundle: true,
        write: false,
        outdir: "/studio-output",
        format: "iife",
        platform: "browser",
        target: ["es2022"],
        jsx: "automatic",
        minify: true,
        sourcemap: false,
        metafile: true,
        logLevel: "silent",
        plugins: [plugin],
        define: {
          "process.env.NODE_ENV": '"production"',
          "import.meta.env.DEV": "false",
          "import.meta.env.PROD": "true",
          "import.meta.env.MODE": '"preview"',
          "import.meta.env.BASE_URL": '"/"',
        },
      });
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        void compiler.cancel();
      }, 10_000);
      try {
        compiled = await compiler.rebuild();
        if (timedOut)
          throw new Error("Preview compilation timed out after 10 seconds");
      } finally {
        clearTimeout(timeout);
        await compiler.dispose();
      }
    } catch (error) {
      const errors = (error as { errors?: Message[] }).errors?.map((value) =>
        diagnostic(value, "error"),
      ) ?? [{ text: (error as Error).message, severity: "error" as const }];
      throw new CodeBuildError(
        errors
          .map(
            (value) =>
              `${value.file ? value.file + (value.line ? ":" + value.line : "") + ": " : ""}${value.text}`,
          )
          .join("\n"),
        errors,
      );
    }
    const javascript =
      compiled.outputFiles
        ?.filter((file) => /\.js$/.test(file.path))
        .map((file) => file.text)
        .join("\n") ?? "";
    const css =
      compiled.outputFiles
        ?.filter((file) => /\.css$/.test(file.path))
        .map((file) => file.text)
        .join("\n") ?? "";
    const output: Record<string, string> = prepared.legacyMode
      ? {
          "index.html": prepared.legacyHtml.replace(
            /(<(?:img|source)\b[^>]*?\bsrc\s*=\s*)(["'])([^"']+)\2/gi,
            (whole, prefix, quote, reference) => {
              if (/^(?:data:|blob:)/i.test(reference)) return whole;
              const path = projectPath(input.entry, reference);
              return path && Object.hasOwn(input.files, path)
                ? prefix +
                    quote +
                    assetDataUrl(path, input.files[path]!) +
                    quote
                : whole;
            },
          ),
          "bundle.css": css,
          ...Object.fromEntries(
            Object.entries(input.files).filter(
              ([path]) => /\.js$/.test(path) && !prepared.used.has(path),
            ),
          ),
        }
      : {
          "index.html": prepared.html,
          "bundle.js": javascript,
          "bundle.css": css,
        };
    if (input.files["contracts.json"])
      output["contracts.json"] = input.files["contracts.json"];
    if (
      Object.values(output).reduce((size, text) => size + text.length, 0) >
      1_950_000
    )
      throw new CodeBuildError(
        "Compiled preview exceeds the 2 MB limit. Import individual components or reduce embedded assets.",
      );
    const versions = new Map(
      codePreviewDependencies().map((value) => [
        value.name as string,
        value.version,
      ]),
    );
    return {
      html: buildPreviewDocument(output, "index.html", input.channel),
      diagnostics: compiled.warnings.map((value) =>
        diagnostic(value, "warning"),
      ),
      dependencies: [...dependencyNames]
        .sort()
        .map((name) => ({ name, version: versions.get(name) ?? "installed" })),
      modules: [...loaded]
        .filter(
          (path) => !path.split('/').pop()!.startsWith('__studio_inline_'),
        )
        .sort(),
    };
  } finally {
    activeBuilds--;
  }
}
