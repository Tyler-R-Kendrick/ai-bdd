import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { chromium, type Browser } from "@playwright/test";
import {
  compileCodePreview,
  codePreviewDependencies,
} from "../server/code-bundler.ts";
import { reactStarter, renameCodeFile } from "../shared/code-project.ts";
import { samplePreviewContract } from "../shared/preview.ts";

let browser: Browser;
let host: Server;
let origin: string;
beforeAll(async () => {
  host = createServer((_req, reply) => {
    reply.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    reply.end("<!doctype html><title>Code preview host</title><body></body>");
  });
  host.listen(0, "127.0.0.1");
  await once(host, "listening");
  origin = `http://127.0.0.1:${(host.address() as { port: number }).port}`;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.STUDIO_CHROMIUM_PATH
      ? { executablePath: process.env.STUDIO_CHROMIUM_PATH }
      : {}),
    args: ["--no-sandbox"],
  });
});
afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve, reject) =>
    host?.close((error) => (error ? reject(error) : resolve())),
  );
});
async function frame(html: string) {
  const page = await browser.newPage();
  await page.goto(origin);
  await page.evaluate((source) => {
    const preview = document.createElement("iframe");
    preview.title = "preview";
    preview.sandbox.add("allow-scripts");
    // Configure the opaque sandboxed document before its first DOM attachment.
    preview.srcdoc = source;
    document.body.append(preview);
  }, html);
  return { page, preview: page.frameLocator("iframe") };
}
describe("bounded source compiler", () => {
  it("bundles real React/TSX modules, JSON, CSS, alias imports and Pact fetch without network", async () => {
    const project = {
      entry: "src/App.tsx",
      files: {
        "src/App.tsx": `import {useState} from 'react';import {label} from '@/label';import './style.css';export default function App(){const [title,setTitle]=useState(label);return <main><h1>{title}</h1><button onClick={()=>fetch('/api/project').then(r=>r.json()).then(data=>setTitle(data.title))}>Load project</button><button onClick={()=>fetch('/missing').catch(()=>setTitle('Boundary blocked'))}>Unmatched</button></main>}`,
        "src/label.ts": `import data from './data.json';export const label:string=data.label`,
        "src/data.json": JSON.stringify({ label: "Typed module" }),
        "src/style.css": "h1{color:rgb(35,80,45)}",
        "contracts.json": JSON.stringify(samplePreviewContract),
      },
    };
    const result = await compileCodePreview({
      ...project,
      channel: "compiler-test",
    });
    expect(result.modules).toEqual([
      "src/App.tsx",
      "src/data.json",
      "src/label.ts",
      "src/style.css",
    ]);
    expect(result.dependencies.map((value) => value.name)).toEqual([
      "react",
      "react-dom",
    ]);
    const { page, preview } = await frame(result.html);
    try {
      await expect
        .poll(() => preview.getByRole("heading").textContent())
        .toBe("Typed module");
      expect(
        await preview
          .getByRole("heading")
          .evaluate((element) => getComputedStyle(element).color),
      ).toBe("rgb(35, 80, 45)");
      await preview.getByRole("button", { name: "Load project" }).click();
      await expect
        .poll(() => preview.getByRole("heading").textContent())
        .toBe("A new idea");
      await preview.getByRole("button", { name: "Unmatched" }).click();
      await expect
        .poll(() => preview.getByRole("heading").textContent())
        .toBe("Boundary blocked");
      expect(
        await preview.locator("body").evaluate(() => {
          try {
            return !!parent.document.body;
          } catch {
            return false;
          }
        }),
      ).toBe(false);
    } finally {
      await page.close();
    }
  });
  it("preserves classic HTML/global-script behavior and rewrites local references without duplication", async () => {
    const result = await compileCodePreview({
      channel: "classic",
      entry: "pages/index.html",
      files: {
        "pages/index.html":
          '<link rel="stylesheet" href="../style.css"><h1>Hello</h1><button onclick="increment()">Increase</button><output id="count">0</output><script src="../main.js"></script>',
        "main.js":
          'var count=0;function increment(){document.getElementById("count").textContent=++count;}',
        "style.css": "h1{color:rgb(12,34,56)}",
      },
    });
    const { page, preview } = await frame(result.html);
    try {
      await preview.getByRole("button", { name: "Increase" }).click();
      await expect
        .poll(() => preview.locator("output").textContent())
        .toBe("1");
    } finally {
      await page.close();
    }
  });
  it("compiles an HTML module entry with local CSS and SVG imports", async () => {
    const result = await compileCodePreview({
      channel: "html-module",
      entry: "index.html",
      files: {
        "index.html":
          '<div id="app"></div><script type="module" src="./main.ts"></script>',
        "main.ts": `import logo from './logo.svg';import './style.css';document.getElementById('app')!.innerHTML='<h1>Module entry</h1><img alt="Local logo" src="'+logo+'">';`,
        "logo.svg":
          '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12" fill="green"/></svg>',
        "style.css": "body{background:#fff}",
      },
    });
    const { page, preview } = await frame(result.html);
    try {
      await expect
        .poll(() => preview.getByRole("heading").textContent())
        .toBe("Module entry");
      await expect
        .poll(() =>
          preview
            .getByRole("img")
            .evaluate(
              (image: HTMLImageElement) => image.complete && image.naturalWidth,
            ),
        )
        .toBe(12);
    } finally {
      await page.close();
    }
  });
  it("reports actionable file/line diagnostics and rejects filesystem, network and uninstalled packages", async () => {
    await expect(
      compileCodePreview({
        ...reactStarter(),
        files: { "bad.tsx": "export default () => <div>" },
        entry: "bad.tsx",
        channel: "bad",
      }),
    ).rejects.toMatchObject({
      diagnostics: [
        expect.objectContaining({
          file: "bad.tsx",
          line: 1,
          severity: "error",
        }),
      ],
    });
    for (const specifier of [
      "node:fs",
      "../../server/auth.ts",
      "/etc/passwd",
      "https://evil.example/app.js",
      "react/../../../server/auth.ts",
      "uninstalled-package",
    ])
      await expect(
        compileCodePreview({
          files: { "main.js": `import ${JSON.stringify(specifier)}` },
          entry: "main.js",
          channel: "blocked",
        }),
      ).rejects.toThrow();
    await expect(
      compileCodePreview({
        files: {
          "index.html": '<script src="https://evil.example/app.js"></script>',
        },
        entry: "index.html",
        channel: "blocked",
      }),
    ).rejects.toThrow("remote script/style");
  });
  it("uses actual installed package versions and rejects incompatible manifests without running scripts", async () => {
    const project = reactStarter();
    const version = codePreviewDependencies().find(
      (value) => value.name === "react",
    )!.version;
    const good = {
      ...project,
      files: {
        ...project.files,
        "package.json": JSON.stringify({
          dependencies: { react: version },
          scripts: { postinstall: "touch /tmp/must-never-execute" },
        }),
      },
    };
    expect(
      (
        await compileCodePreview({ ...good, channel: "manifest" })
      ).dependencies.find((value) => value.name === "react")!.version,
    ).toBe(version);
    for (const requested of ["18.0.0", "^19.99.0", "file:../../secret"])
      await expect(
        compileCodePreview({
          ...good,
          files: {
            ...good.files,
            "package.json": JSON.stringify({
              dependencies: { react: requested },
            }),
          },
          channel: "manifest",
        }),
      ).rejects.toThrow();
  });
  it("rewrites local imports when moving files while retaining module meaning", async () => {
    const project = {
      files: {
        "src/App.tsx": `import {Label} from './components/Label';export default ()=><Label/>`,
        "src/components/Label.tsx": `import text from '../data.json';export const Label=()=> <h1>{text.label}</h1>`,
        "src/data.json": '{"label":"Renamed component"}',
      },
      entry: "src/App.tsx",
    };
    const renamed = renameCodeFile(
      project,
      "src/components/Label.tsx",
      "ui/Label.tsx",
    );
    expect(renamed.files["src/App.tsx"]).toContain("from '../ui/Label'");
    expect(renamed.files["ui/Label.tsx"]).toContain("from '../src/data.json'");
    const { page, preview } = await frame(
      (await compileCodePreview({ ...renamed, channel: "rename" })).html,
    );
    try {
      await expect
        .poll(() => preview.getByRole("heading").textContent())
        .toBe("Renamed component");
    } finally {
      await page.close();
    }
  });
});

it("resolves inline module imports relative to a nested HTML entry", async () => {
  const result = await compileCodePreview({
    channel: "nested-html",
    entry: "pages/index.html",
    files: {
      "pages/index.html":
        '<h1></h1><script type="module">import {title} from "./title.ts";document.querySelector("h1").textContent=title;</script>',
      "pages/title.ts": 'export const title:string="Nested module"',
    },
  });
  const { page, preview } = await frame(result.html);
  try {
    await expect
      .poll(() => preview.getByRole("heading").textContent())
      .toBe("Nested module");
  } finally {
    await page.close();
  }
});
