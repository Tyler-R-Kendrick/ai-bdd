import { describe, expect, it } from "vitest";
import { exportCodeZip, importCodeZip } from "../shared/code-archive.ts";
import { renameCodeFile, reactStarter } from "../shared/code-project.ts";

describe("portable code projects", () => {
  it("round-trips real project files, Unicode source and the exact entry in a standard ZIP", async () => {
    const project = reactStarter();
    project.files["studio-project.json"] = '{"custom":true}';
    project.files["README.md"] = "こんにちは 👋";
    const zip = exportCodeZip(project);
    expect(Array.from(zip.subarray(0, 4))).toEqual([80, 75, 3, 4]);
    expect(await importCodeZip(zip)).toEqual(project);
  });
  it("rejects corrupt content, path traversal and duplicate destinations", async () => {
    const zip = exportCodeZip(reactStarter());
    const tampered = zip.slice();
    tampered[100] = tampered[100]! ^ 1;
    await expect(importCodeZip(tampered)).rejects.toThrow();
    expect(() =>
      exportCodeZip({ files: { "../secret.js": "x" }, entry: "../secret.js" }),
    ).toThrow();
    expect(() =>
      renameCodeFile(
        { files: { "one.js": "", "two.js": "" }, entry: "one.js" },
        "one.js",
        "two.js",
      ),
    ).toThrow("already exists");
    await expect(importCodeZip(new Uint8Array(5_000_000))).rejects.toThrow(
      "4 MB",
    );
  });
  it("updates relative HTML links and the selected entry when renaming", () => {
    const renamed = renameCodeFile(
      {
        files: {
          "index.html": '<script src="src/main.js"></script>',
          "src/main.js": "console.log(1)",
        },
        entry: "index.html",
      },
      "src/main.js",
      "app/start.js",
    );
    expect(renamed.files["index.html"]).toContain('src="app/start.js"');
    const moved = renameCodeFile(renamed, "index.html", "pages/preview.html");
    expect(moved.entry).toBe("pages/preview.html");
    expect(moved.files[moved.entry]).toContain("../app/start.js");
  });
});
