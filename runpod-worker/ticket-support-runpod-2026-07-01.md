Subject: Serverless worker silently killed mid-job at ~36-46s, independent of app code — heartbeat healthy, no crash logged

Endpoint ID: ppmj21flholosp (formal_amber_platypus)
Docker image: pickinsitu/bc-archi-odm (tested v28 through v34)
GPU pool: ADA_80_PRO
Config: workersMax=2, workersMin=0, idleTimeout=5s, scalerType=QUEUE_DELAY(4), executionTimeoutMs=3600000

## Symptom

Every job running our ODM (OpenDroneMap) photogrammetry pipeline is killed at approximately 36-46 seconds of execution, mid-computation, with no error, no exception, and no exit code logged by our application. The platform then reassigns the job to a second worker, which dies the same way, and the job ultimately fails with "job timed out after 1 retries" despite executionTimeoutMs being set to 3600000 (1 hour).

Short jobs (<36s) on this same endpoint complete successfully (7 completed jobs recorded). Only long-running jobs are affected.

Recent failed job examples:
- job f8d9da8c-3cc8-4567-9119-a3ff1a1f523f-e2 — worker k077kwbvc8xv1s — executionTime 73009ms
- job 94ec58a1-7ee8-4fed-a46a-547a3515a19b-e2 — worker 10pht122u3rn4r — executionTime 73955ms
- job c9b662d7-16c4-4a44-8ac1-f13fa15cc4b8-e1 — worker nbvxm8qbzd5bce — executionTime 77575ms
- job 013089c4-a146-4429-964e-27dc99424034-e2 — worker i2u8xa9g0i6mge — reassigned after first attempt, second attempt also killed ~43-46s in

## What we've ruled out (with evidence)

We built a diagnostic image (v34) that logs, in addition to our normal application output:
1. A memory/disk monitor thread (independent of the ODM subprocess) printing every 3s: cgroup memory.current, oom_kill counter, /tmp free space.
2. A wrapped RunPod SDK heartbeat (`runpod.serverless.modules.rp_ping.Heartbeat._send_ping`) logging every ping attempt with elapsed time, job_id, and HTTP status.

Results from two consecutive job attempts on v34 (same job, worker died and was reassigned once):

| Hypothesis | Verdict | Evidence |
|---|---|---|
| OOM (RAM) | Ruled out | Memory monitor shows peak ~1-4GB against a 233GB cgroup limit; `oom_kill=0` throughout |
| Disk full (/tmp) | Ruled out | Constant ~19-20GB free on /tmp |
| executionTimeoutMs too short | Ruled out | Confirmed via GraphQL API: 3600000ms (1h) |
| Spot preemption / unhealthy worker | Ruled out | API shows `throttled:0, unhealthy:0` for the endpoint |
| Blocking sync handler freezing asyncio loop | Ruled out | Handler is async, offloading work via `run_in_executor`; still dies at the same mark |
| SDK heartbeat failing/not sending | Ruled out | `[diag-ping] t=Ns ... -> HTTP 200` logged continuously every ~4s (RUNPOD_PING_INTERVAL=4000) right up to the last log line before death — no failed ping, no missing ping |
| Application-level crash/exception | Ruled out | No Python traceback, no non-zero exit code captured, no signal handled — our own memory-monitor thread (fully decoupled from the ODM subprocess) also stops logging at the exact same instant, which only happens if the entire container process is terminated externally, not if a subprocess or a specific thread crashes |

## Key log excerpt (job 013089c4-a146-4429-964e-27dc99424034-e2, worker i2u8xa9g0i6mge, second attempt)

```
[BC-ARCHI] Worker ODM démarré v34 (diagnostic heartbeat)
[BC-ARCHI][diag-hb] API_KEY=oui POD_ID=i2u8xa9g0i6mge PING_INTERVAL=4000 PING_URL=défini GET_JOB=défini
[BC-ARCHI][diag-hb] wrap _send_ping installé
[diag-ping] t=0s job_id=None -> HTTP 200
... (job starts, photos download, ODM pipeline runs: dataset/split/merge/opensfm/openmvs stages all complete normally) ...
[diag-ping] t=38s job_id=013089c4-... -> HTTP 200
[mon] mem.current=0.85Go oom_kill=0 /tmp=19.8Go libre
... (DensifyPointCloud completes, 402477 points densified, FPCFilter completes, odm_meshing stage starts, DSM tiles generated, mesh_dsm.tif written) ...
running dem2mesh -inputFile mesh_dsm.tif -outputFile odm_25dmesh.dirty.ply -maxTileLength 2000 -maxVertexCount 200000 -maxConcurrency 4 -edgeSwapThreshold 0.15 -verbose
[diag-ping] t=43s job_id=013089c4-... -> HTTP 200
[mon] mem.current=2.90Go oom_kill=0 /tmp=19.7Go libre
--- nothing after this line: no ping error, no exception, no exit code, container terminated ---
```

The heartbeat and memory monitor were both alive and logging normally 1-2 seconds before termination. There is no gap or slowdown leading up to the kill — it is an abrupt, total stop of all logging from the container.

## Additional evidence: platform system log shows a near-fixed ~34-35s container lifetime, no probe/health message

We pulled the raw RunPod system log (Console → Serverless → endpoint → worker) for two consecutive container attempts of the same job (image v34):

```
2026-06-30T16:36:50Z start container for pickinsitu/bc-archi-odm:v34: begin
2026-06-30T16:37:24Z stop container 80a78ddc...          <- 34s after start
2026-06-30T16:37:40Z remove container
2026-06-30T16:38:14Z create container pickinsitu/bc-archi-odm:v34
2026-06-30T16:38:14Z start container for pickinsitu/bc-archi-odm:v34: begin
2026-06-30T16:38:49Z stop container 000db021...          <- 35s after start
2026-06-30T16:39:04Z remove container
```

Two things stand out:

1. **No probe/health-check message anywhere in this log** — no "liveness probe failed", "readiness probe failed", or "health check failed" string. Just `start` → `stop` → `remove`, with no reason given.
2. **The duration from "start container: begin" to "stop container" is nearly identical across two independent attempts (34s, then 35s)**, despite the actual application-level CPU load differing between attempts (different point in the ODM pipeline, different job state at that moment — confirmed by our own diagnostic logs). If this were a liveness/readiness probe failing due to variable CPU contention (dem2mesh saturating the CPU at a somewhat unpredictable moment in the pipeline), we would expect more variance in the exact kill timing run to run. A window this tight and reproducible across unrelated attempts looks more consistent with a **fixed platform-side timer** on the container lifecycle (possibly tied to job/worker assignment or scheduling, independent of `executionTimeoutMs`) than with a CPU-starvation-triggered probe failure.

This is our strongest single piece of evidence and the main thing we'd like RunPod engineering to look at directly, since it isn't visible or explainable from the client side.

## UPDATE — issue persists on a freshly recreated endpoint for longer jobs

We recreated the endpoint from scratch (new endpoint `alfkh0yfkkfukq`, new template, same image/GPU). Short jobs (5 photos, ~80s) now complete reliably. But **longer jobs still fail the same way**: a 30-photo job is killed and reassigned mid-processing, `retried` counter climbing, ending in `job timed out after 1 retries` at ~137s executionTime — far below the endpoint `executionTimeoutMs` of 3600000 (1h).

Crucially this was reproduced on a **guaranteed-fresh worker**: we scaled the endpoint to `workersMax=0`, waited for all workers to drain to 0, scaled back to 2, and resubmitted — so it was a cold-started worker on the current image, not a stale cached one. It still got reassigned/killed.

- Failed long job: `cc9f35f3-17fc-4f0d-80c7-f631717ecdbf-e1`, worker `z5ni3vgow0lm2c`, endpoint `alfkh0yfkkfukq`, executionTime ~137093ms, error `job timed out after 1 retries`.
- Application logs show heavy CPU stages (dense reconstruction / meshing run CPU-side) proceeding normally with memory well within limits, then the container is reassigned — no OOM, no app exception.

So recreating the endpoint raised the tolerance (short jobs work) but did **not** eliminate the underlying behaviour for longer-running jobs. We'd like RunPod engineering to identify what health/liveness or scheduler mechanism reassigns a busy worker well before `executionTimeoutMs`, and how to keep a long (multi-minute) CPU-bound job alive.

## What we're asking

1. Could you check the worker-side lifecycle/eviction reason for these specific job/worker IDs (especially `013089c4-a146-4429-964e-27dc99424034-e2` / `i2u8xa9g0i6mge`)? We'd like to know if this is a resource limit, a host-level watchdog, or a scheduler decision unrelated to the SDK heartbeat.
2. Is there any timeout or liveness check on this endpoint/GPU pool (ADA_80_PRO) shorter than executionTimeoutMs that isn't documented as part of the public heartbeat/ping mechanism?
3. We haven't yet tried running with an "always-on" (workersMin=1) warm worker to see if the same kill happens outside of cold-start scaling — could you confirm whether that variable is relevant here, or whether this endpoint has a known issue independent of scaling mode?

Happy to provide the full raw logs for any of the job IDs above, or to run further diagnostics on request.

## UPDATE 2 — ran the requested workersMin=1 (always-warm worker) test: SAME failure

Per your request, we set `workersMin=1` on endpoint `alfkh0yfkkfukq` and waited for the worker to reach `ready`/`idle` before submitting, so the job was served by an already-warm worker (no cold-start, no scale-up). We submitted a 26-photo ODM job (downscaled, ~31 MB total — deliberately small to remove transfer time as a factor).

Result: **identical failure**, `job timed out after 1 retries`.

- job `2262c1cc-ab3b-43fe-acc9-fec67fbdbe20-e1`, worker `rx3asfeww9a18j`, endpoint `alfkh0yfkkfukq`
- `executionTime` 49640 ms, `delayTime` 43533 ms, `retries` 1, `status` FAILED
- Endpoint health at failure: `workers.unhealthy=0, throttled=0`; `executionTimeoutMs=3600000` (unchanged)

Conclusion on our side: **the kill is independent of scaling mode / cold-start.** A permanently warm worker is reassigned and the job times out at roughly the same point as with `workersMin=0`. This strengthens our belief that a host-level watchdog or scheduler mechanism — not the SDK heartbeat and not `executionTimeoutMs` — is evicting busy, healthy, CPU-bound workers.

Could you please inspect the eviction reason for worker `rx3asfeww9a18j` / job `2262c1cc-ab3b-43fe-acc9-fec67fbdbe20-e1` directly? This test was run specifically at your request to isolate the warm-vs-cold variable.

## UPDATE 3 — applied your image recommendation (driver constraint) AND ruled out our own resource usage; job still killed at ~150s execution

Following your driver/CUDA feedback we made two changes and rebuilt the image:

1. **Driver 580.xx compatibility (your recommendation).** We added `ENV NVIDIA_DISABLE_REQUIRE=1` to bypass the base image's `NVIDIA_REQUIRE_CUDA` constraint (which excluded the 580.xx series). New image `pickinsitu/bc-archi-odm:v41`, deployed to template `1m86lf79f7`, workers cold-started fresh on it.
2. **Ruled out our own memory pressure.** We then also dropped our ODM `--max-concurrency` from 4 to 1 (image `v42`) to eliminate any chance of a parallel-process memory spike on our side.

Result — the job now runs **much further** than before (no more early death) but is **still killed at ~150s of execution**, mid dense-reconstruction, with the same `job timed out after 1 retries`, on a cold-started worker, with `executionTimeoutMs=3600000` (verified again just now via the REST API):

| Image | Change | Fresh request ID | executionTime at kill |
|---|---|---|---|
| v41 | driver bypass, conc 4 | `17c37c00-43fe-4de7-993c-d93bac7950d0-e1` (worker `74docsvmqzdpjx`) | 147572 ms |
| v42 | driver bypass, conc 1 | `e5ad435a-7cb0-418b-82f1-913a328e1100-e2` (worker `d7sekoxcm9wn7z`) | 153092 ms |

Both die at essentially the same ~150s execution mark regardless of our concurrency, so this is **not** OOM/resource pressure on our side, and applying the driver recommendation did not eliminate it. Our application status was still `processing` (dense reconstruction) with no output uploaded — i.e. the container was terminated externally, not an app error.

Endpoint config at the time (REST `GET /v1/endpoints/alfkh0yfkkfukq`): `executionTimeoutMs: 3600000`, `idleTimeout: 60`, `scalerType: QUEUE_DELAY(4)`, `workersMin: 0/1 tested`, `workersMax: 2`.

Per your instruction ("let us know the new request ID if you continue to experience the issue"): the two IDs above are the post-fix reproductions. **Could you inspect the worker-side termination reason for `e5ad435a-7cb0-418b-82f1-913a328e1100-e2` / worker `d7sekoxcm9wn7z`?** We would specifically like to know whether there is any per-attempt execution ceiling around ~150s on this endpoint/GPU pool that is independent of `executionTimeoutMs`, since three independent post-fix attempts now cluster tightly at ~147–153s.
