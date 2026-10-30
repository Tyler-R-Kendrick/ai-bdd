# Spatial authoring browser review

Fresh captures from the locally built spatial-stack head, using synthetic authenticated projects. Both images were opened and checked against the browser assertions.

- `cad-exact.png`: dimension-driven mounting plate and subtractive hole, feature history, actual worker B-rep face count and measured volume. The test changes dimensions, saves/reloads, exports analytic STEP, and re-imports that STEP into an owned artifact.
- `scene-import.png`: uploaded GLB scene with material/light settings, retained hierarchy and transforms through save/reload/export.

Production build, 148 checks, and all 29 browser cases passed locally. The focused CAD cases also check viewer restrictions. The measurements substantiate the exercised geometry; these captures do not certify arbitrary CAD models or claim complete professional CAD-suite parity or production deployment.
