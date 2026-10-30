# CAD kernel notices, corresponding source, and replacement

Studio's exact CAD worker uses **replicad 1.2.0** (MIT) and the unmodified **replicad-opencascadejs 1.1.0** JavaScript/WASM library (LGPL-2.1-only). The library is loaded separately in `kernel.worker-*.js` and `replicad_single-*.wasm`; the application does not accept or evaluate uploaded JavaScript.

The LGPL text is served at [replicad-opencascadejs.txt](replicad-opencascadejs.txt). Open CASCADE Technology's [LGPL text](LICENSE_LGPL_21.txt) and [additional exception](OCCT_LGPL_EXCEPTION.txt) are supplied separately. The kernel includes FreeType, licensed under the [FreeType License](occt-freetype-FTL.txt), and RapidJSON, whose [notices](occt-rapidjson.txt) are retained. Portions of this software are copyright © The FreeType Project (www.freetype.org). All rights reserved.

## Exact source mapping

The published wrapper package records gitHead `e4b05f67dc4e2393a876ce8c5064a9c93db05bf1`. Its actual build scripts and binding configuration are under `packages/replicad-opencascadejs` in that source revision:

- [Wrapper and binding source tree](https://github.com/sgenoud/replicad/tree/e4b05f67dc4e2393a876ce8c5064a9c93db05bf1/packages/replicad-opencascadejs)
- [Complete wrapper source archive](https://github.com/sgenoud/replicad/archive/e4b05f67dc4e2393a876ce8c5064a9c93db05bf1.tar.gz)
- [Pinned build-image source](https://github.com/taucad/opencascade.js/tree/ebd263f15337b440b391492af073662707e86482)
- [Build-image source archive](https://github.com/taucad/opencascade.js/archive/ebd263f15337b440b391492af073662707e86482.tar.gz)
- [Its dependency lock](https://github.com/taucad/opencascade.js/blob/ebd263f15337b440b391492af073662707e86482/DEPS.json)
- [OCCT V8_0_1 source archive](https://github.com/Open-Cascade-SAS/OCCT/archive/b8f597c677811d1f9f4d8a97f5ae2825c0353a42.tar.gz)
- [FreeType source archive](https://github.com/freetype/freetype/archive/de8b92dd7ec634e9e2b25ef534c54a3537555c11.tar.gz)
- [RapidJSON source archive](https://github.com/Tencent/rapidjson/archive/24b5e7a8b27f42fa16b96fc70aade9106cf7102f.tar.gz)

The build lock fixes Emscripten 5.0.1 and its container digest `sha256:c89732ef63a56de5a96395c5a8c1c7904f7420131a045406e6fedc4cbe1cc198`. The wrapper's single-thread build invokes `ghcr.io/taucad/opencascade.js:canary-ebd263f1-single-threaded` with the generated binding YAML. No library code was modified for Studio; only Studio's own declarative model adapter and worker were added.

## Rebuild or modify the library

Docker, git, npm, and Carvel `ytt` are prerequisites. These are upstream source-build steps, not a claim of bit-for-bit output attestation:

```sh
git clone https://github.com/taucad/opencascade.js.git work/ocjs-source
git -C work/ocjs-source checkout ebd263f15337b440b391492af073662707e86482
docker build --target final-single -t ghcr.io/taucad/opencascade.js:canary-ebd263f1-single-threaded work/ocjs-source
git clone https://github.com/sgenoud/replicad.git work/replicad-source
git -C work/replicad-source checkout e4b05f67dc4e2393a876ce8c5064a9c93db05bf1
cd work/replicad-source/packages/replicad-opencascadejs
npm run generateConfig
npm run buildSingle
```

The generated `dist/replicad_single.js`, `.cjs`, `.d.ts`, and `.wasm` replace the same four files in the pinned dependency. The complete Studio source is available in this repository, including `client/editors/scene/kernel.ts`, `kernel.worker.ts`, and the package lock. Studio is MIT licensed; users may modify the LGPL library for their own use and reverse-engineer the application as necessary to debug those library modifications.

From the Studio repository root, use the package manager's patch mechanism rather than editing a shared installation:

```sh
pnpm patch replicad-opencascadejs@1.1.0
# Copy the rebuilt dist files into the patch directory printed above.
pnpm patch-commit <printed-patch-directory>
pnpm --filter @ai-bdd/studio build
```

The resulting worker and WASM remain separate browser assets. Deploy the rebuilt application assets together so their generated filenames agree. No signing gate prevents use of a modified compatible kernel. If redistributing a modified kernel, retain these notices and provide the complete corresponding library sources, build configuration, and changes alongside the binary distribution. Do not substitute an incompatible WASM ABI without its matching JavaScript bindings.
