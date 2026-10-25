// @effect-diagnostics nodeBuiltinImport:off
// Manual check, not part of the patch: runs the patched V2 startup path
// (initializeV2Database -> migrations -> legacy shell import -> transcripts)
// against a COPY of a real ~/.t3/userdata directory.
//
//   cp this file to apps/server/src/persistence/ in a patched checkout, then
//   echo /tmp/some-copy > /tmp/t3code-real-db-dir.txt   (or T3CODE_REAL_DB_DIR=...)
//   vp test run apps/server/src/persistence/realdbLegacyImport.test.ts
//
// The directory must contain state.sqlite (+ -wal/-shm) and statev2.sqlite.
// It is modified (it is the V2 database under test), so pass a copy.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "./Sqlite.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";

// oxlint-disable-next-line t3code/no-global-process-runtime -- manual fixture switch
const pointer = NodePath.join(NodeOS.tmpdir(), "t3code-real-db-dir.txt");
// vp test does not forward arbitrary env vars to workers, so a pointer file works too.
const directory =
  process.env.T3CODE_REAL_DB_DIR ??
  (NodeFS.existsSync(pointer) ? NodeFS.readFileSync(pointer, "utf8").trim() : "");

it.effect.skipIf(directory === "")(
  "imports every live V1 thread of a real userdata copy",
  () => {
    const sourcePath = NodePath.join(directory, "state.sqlite");
    const destinationPath = NodePath.join(directory, "statev2.sqlite");
    const v1 = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
    const v1Threads = v1
      .prepare(
        "SELECT thread_id, title, (SELECT count(*) FROM projection_thread_messages m WHERE m.thread_id = t.thread_id AND m.role IN ('user', 'assistant')) AS messages FROM projection_threads t WHERE deleted_at IS NULL",
      )
      .all() as Array<{ thread_id: string; title: string; messages: number }>;
    v1.close();
    const v1Hash = NodeFS.readFileSync(sourcePath).toString("base64").length;

    return Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const layerDatabase = SqlitePersistence.layerConfig.pipe(
        Layer.provide(ServerConfig.layer({ ...config, dbPath: destinationPath })),
      );
      const layerStores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
        Layer.provideMerge(layerDatabase),
      );
      const layerSink = EventSink.layer.pipe(Layer.provide(layerStores));
      const layerImporter = LegacyV1ThreadImporter.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(layerStores, layerSink)),
      );
      yield* Effect.gen(function* () {
        const legacy = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const shells = yield* legacy.reconcileShells;
        yield* Effect.logInfo("shells", shells);
        const transcripts = yield* legacy.importPendingTranscripts;
        yield* Effect.logInfo("transcripts", transcripts);
        for (const row of v1Threads) {
          const projection = yield* projections.getThreadProjection(ThreadId.make(row.thread_id));
          console.log(
            `IMPORTED ${row.thread_id} "${projection.thread.title}" v1Messages=${row.messages} v2Messages=${projection.messages.length}`,
          );
          assert.equal(projection.thread.title, row.title);
          assert.equal(projection.messages.length, row.messages);
        }
      }).pipe(Effect.provide(layerImporter));
      assert.equal(NodeFS.readFileSync(sourcePath).toString("base64").length, v1Hash);
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(directory, directory).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );
  },
  600_000,
);
