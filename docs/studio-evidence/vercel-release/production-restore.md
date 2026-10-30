The production restore rehearsal passed on 2026-10-30 using shipping Studio source `a4c7fdd85e36ca366587b2dbbdd8557d255da758`. It restored an actual Neon snapshot into a separate recovery branch, verified the restored application, copied two synthetic media files into private backup objects, restored bytes from those backups into different private objects, and verified the application again using the relocated recovery records.

| Resource | Retained result |
| --- | --- |
| Production snapshot | `snap-dawn-credit-b8ku233q`, created `2026-10-30T17:03:58Z`, manual, no expiration configured |
| Recovery branch | `br-silent-sun-b8undf4g`, `production-recovery-20261030` |
| Recovery compute | `ep-odd-snow-b82wp52t`, fixed 0.25 CU, observed `idle` at `2026-10-30T17:52:45Z` |
| Production branch and endpoint | `br-shiny-fire-b8tn4wiv` remained the default production branch; `ep-royal-glade-b825vgbx` remained attached to it |

The snapshot restore used `finalize:false`. No finalize, production reset, branch rename, or branch deletion was performed. The account rejected an explicit suspend interval, so the recovery endpoint retained the provider default (`suspend_timeout_seconds:0`); its automatic suspension was then observed.

The first hosted phase proved the exact selected SQL clone and reads from retained original objects. Its selected fixture bundle SHA-256 was `bbaf904fabc5e8612c0be943ec25b7b3fb825919acc3d744b9cc5c75593e5efc`, unchanged before and after the application reads. The selected records covered two projects, three artifacts, two chat messages, three ADRs, two completed render jobs, and one publication receipt for each render.

The second phase read each original file, wrote an immutable private backup copy, read that backup, wrote a different restored copy from the backup bytes, and verified the restored copy. The four payload objects total 101,338 bytes. A 2,017-byte private recovery manifest was also retained at `studio/v1/recovery/backup/snap-dawn-credit-b8ku233q/manifest.json`, with SHA-256 `75b60de7a2bfeac7a88e3ce8d42ac8b7c6ad948a3028c80fd22b0e4ab0d79048`. All five assets remain in the existing production private Blob store. Writes used `allowOverwrite:false`, `addRandomSuffix:false`, and private access; original objects were preserved.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| WAV `98561d0b-c169-4321-873a-179fdd7f3753` | 48,078 | `be0eabf151ad7d3d1dba503bbe9981f9958d6dc672fc7e2d035bd87e8bf3da3f` |
| MP4 `4bf1e47f-d55c-44fd-b864-ef2931ae299d` | 2,591 | `1654f5f7af92270b9004c400a622974f4ce38f5d93230f5c22dcde328b4f8a99` |

Only those two recovery-branch `files.storage_key` values were conditionally and atomically changed to `studio/v1/recovery/restored/snap-dawn-credit-b8ku233q/{sha256}`. All other selected data matched the original baseline before and after the second application proof. Read-only production SQL confirmed the original production file keys, hashes, and sizes were preserved. This intentional recovery pointer relocation is separate from the earlier exact SQL clone proof.

Both successful previews used an actual connected GitSource with the exact disposable branch and source SHA. Each phase passed 19 validations across 26 HTTP requests: 18 responses with status 200 and eight application-anonymous rejections with status 401. Each used two distinct fresh owner sessions, found both new sessions on the recovery database and none on production, verified the selected content and history, and fetched each private file twice with the expected SHA-256, size, and MIME type. In the second phase, the file records pointed to the restored copies, so these reads proved restored-copy delivery through the shipping App. Requests used GET and POST `/api/auth/login` only; the rehearsal admitted no model, render, bootstrap, or maintenance work.

An initial CLI file-upload preview carried display Git metadata without an actual GitSource and returned 401 for the restored owner. It was removed and replaced before further testing. The later proofs used explicit GitSource branch and commit binding. The three owned preview deployments were deleted and confirmed absent, the four exact-branch environment overrides were removed, and `refs/heads/codex/production-restore-a4` was removed. Global critical production and preview bindings remained present. No protection bypass or access-control change was used.

The manifest exposed a concrete SDK edge case: its HEAD size and actual bounded stream were 2,017 bytes, while `get.blob.size` reported zero. The original adapter rejected that metadata sentinel. A bounded private SDK read still verified the exact manifest bytes, and adapter fix `8b4ea1bad7479bc0fb5fc92d3c1be9024144e3d1` independently read the existing manifest successfully at `2026-10-30T17:37:30.700Z`, without writes or deletes. The source-pinned App proofs above used the media objects; the manifest adapter fix is recorded separately.

This is a bounded recovery rehearsal for the selected synthetic records and two media files within one retained private store. It does not establish independent provider-loss, store-loss, cross-region, or high-availability recovery. The optional shared-preview session absence check was rejected by automatic approval review as an out-of-scope credential-related read; no result is claimed for it, and it was dropped after the explicit review notice.

The complete metadata receipt is [production-restore.json](production-restore.json). The earlier original-reference phase is [production-restore-core.json](production-restore-core.json). The separate production browser-import fixture created after the snapshot is excluded from this baseline; its read-only SQL metadata support is [production-import-sql-metadata.json](production-import-sql-metadata.json).
