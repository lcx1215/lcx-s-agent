import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalTextWorker, readLocalTextWorkerSnapshot } from "./local-text-worker.js";
const workers: LocalTextWorker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
});
function worker() {
  const script = `console.log(JSON.stringify({ready:true,weightsLoaded:false}));
  require('node:readline').createInterface({input:process.stdin}).on('line', line => {
    const r=JSON.parse(line); if(r.prompt==='hang') return; if(r.prompt==='crash') process.exit(2);
    console.log(JSON.stringify({id:r.id,event:'loading',weightsLoaded:false}));
    if(r.prompt==='loadingOnly') return;
    console.log(JSON.stringify({id:r.id,event:'loaded',weightsLoaded:true}));
    if(r.prompt==='loadedOnly') return;
    if(r.prompt==='fail') {
      console.log(JSON.stringify({id:r.id,error:'local_inference_failed',weightsLoaded:true})); return;
    }
    console.log(JSON.stringify({id:r.id,text:JSON.stringify({echo:r.prompt,pid:process.pid}),weightsLoaded:true}));
  });`;
  const result = new LocalTextWorker(process.execPath, ["-e", script]);
  workers.push(result);
  return result;
}
describe("resident local worker lifecycle", () => {
  it("keeps the Python protocol lazy and publishes load events through redirected stdout", async () => {
    // Stub MLX in-process: exercise the actual Python worker without loading weights.
    const script = `import json, runpy, sys, time, types
mx = types.ModuleType('mlx.core')
for name in ('set_cache_limit', 'set_memory_limit', 'clear_cache'):
    setattr(mx, name, lambda *args: None)
mlx = types.ModuleType('mlx')
mlx.core = mx
lm = types.ModuleType('mlx_lm')
loads = 0
class Tokenizer:
    def apply_chat_template(self, messages, **kwargs):
        return messages[0]['content']
def load(model):
    global loads
    loads += 1
    print('library load output')
    time.sleep(0.1)
    return object(), Tokenizer()
def generate(model, tokenizer, prompt, **kwargs):
    time.sleep(0.2)
    return json.dumps({'echo': prompt, 'loads': loads})
lm.load = load
lm.generate = generate
samples = types.ModuleType('mlx_lm.sample_utils')
samples.make_sampler = lambda **kwargs: None
lock = types.ModuleType('fcntl')
lock.LOCK_EX = lock.LOCK_NB = 1
lock.flock = lambda *args: None
sys.modules.update({'mlx': mlx, 'mlx.core': mx, 'mlx_lm': lm,
    'mlx_lm.sample_utils': samples, 'fcntl': lock})
worker_path = sys.argv.pop(1)
runpy.run_path(worker_path, run_name='__main__')`;
    const w = new LocalTextWorker("python3", [
      "-c",
      script,
      fileURLToPath(new URL("../../scripts/local-model/lcx_text_worker.py", import.meta.url)),
      "--model",
      "offline-test",
    ]);
    workers.push(w);
    w.start();
    await vi.waitFor(() => expect(w.snapshot().protocolReady).toBe(true));
    expect(w.snapshot().weightsLoaded).toBe(false);
    const first = w.invoke("one", 10, 2000, new AbortController().signal);
    await vi.waitFor(() => expect(w.snapshot().loading).toBe(true));
    await vi.waitFor(() => expect(w.snapshot().weightsLoaded).toBe(true));
    expect(w.snapshot()).toMatchObject({
      busy: true,
      lastInferenceSucceededAt: null,
      inferenceEvidence: "not_inference_proven",
    });
    expect(JSON.parse((await first).text)).toEqual({ echo: "one", loads: 1 });
    expect(w.snapshot().lastInferenceSucceededAt).toEqual(expect.any(String));
    const second = await w.invoke("two", 10, 2000, new AbortController().signal);
    expect(JSON.parse(second.text)).toEqual({ echo: "two", loads: 1 });
  });
  it("reads an absent host worker without assembling one", () => {
    expect(readLocalTextWorkerSnapshot()).toBeUndefined();
  });
  it("distinguishes protocol readiness from loaded weights and inference evidence", async () => {
    const w = worker();
    expect(w.snapshot()).toMatchObject({ pid: null, protocolReady: false, weightsLoaded: false });
    w.start();
    await vi.waitFor(() => expect(w.snapshot().protocolReady).toBe(true));
    expect(w.snapshot()).toMatchObject({
      weightsLoaded: false,
      loading: false,
      busy: false,
      lastInferenceSucceededAt: null,
      lastFailure: null,
      inferenceEvidence: "not_inference_proven",
    });
  });
  it.each([
    { prompt: "loadingOnly", loading: true, weightsLoaded: false },
    { prompt: "loadedOnly", loading: false, weightsLoaded: true },
  ])("observes $prompt without treating it as successful inference", async (expected) => {
    const w = worker();
    const abort = new AbortController();
    const pending = w.invoke(expected.prompt, 10, 2000, abort.signal);
    const rejection = expect(pending).rejects.toThrow("cancelled");
    await vi.waitFor(() =>
      expect(w.snapshot()).toMatchObject({
        protocolReady: true,
        loading: expected.loading,
        weightsLoaded: expected.weightsLoaded,
        busy: true,
        lastInferenceSucceededAt: null,
        inferenceEvidence: "not_inference_proven",
      }),
    );
    abort.abort();
    await rejection;
    await w.stop();
    expect(w.snapshot()).toMatchObject({
      protocolReady: false,
      weightsLoaded: false,
      busy: false,
      lastFailure: { code: "local_worker_cancelled" },
    });
  });
  it("records genuine replies and resets their evidence on crash and automatic restart", async () => {
    const w = worker();
    w.start();
    const first = await w.invoke("one", 10, 2000, new AbortController().signal);
    expect(w.snapshot()).toMatchObject({
      weightsLoaded: true,
      loading: false,
      busy: false,
      lastInferenceSucceededAt: expect.any(String),
      inferenceEvidence: "inference_succeeded",
    });
    await expect(w.invoke("crash", 10, 2000, new AbortController().signal)).rejects.toThrow(
      "exited",
    );
    expect(w.snapshot()).toMatchObject({
      pid: null,
      protocolReady: false,
      weightsLoaded: false,
      lastInferenceSucceededAt: null,
      lastFailure: { code: "local_worker_exited", at: expect.any(String) },
      inferenceEvidence: "not_inference_proven",
    });
    await vi.waitFor(() => expect(w.snapshot().protocolReady).toBe(true), { timeout: 3000 });
    expect(w.snapshot().pid).not.toBe(first.pid);
    expect(w.snapshot()).toMatchObject({ weightsLoaded: false, lastInferenceSucceededAt: null });
  });
  it("reports load success and inference failure separately and returns detached snapshots", async () => {
    const w = worker();
    await expect(w.invoke("fail", 10, 2000, new AbortController().signal)).rejects.toThrow(
      "inference_failed",
    );
    expect(w.snapshot()).toMatchObject({
      weightsLoaded: true,
      lastInferenceSucceededAt: null,
      lastFailure: { code: "local_worker_inference_failed" },
    });
    const detached = w.snapshot();
    if (detached.lastFailure) {
      detached.lastFailure.code = "changed";
    }
    expect(w.snapshot().lastFailure?.code).toBe("local_worker_inference_failed");
  });
  it("reuses one process across batches and stops it with its host", async () => {
    const w = worker();
    w.start();
    const first = await w.invoke("one", 10, 2000, new AbortController().signal);
    const second = await w.invoke("two", 10, 2000, new AbortController().signal);
    expect(first.pid).toBe(second.pid);
    expect(JSON.parse(second.text).echo).toBe("two");
    await w.stop();
    expect(w.snapshot()).toMatchObject({
      pid: null,
      protocolReady: false,
      weightsLoaded: false,
      lastInferenceSucceededAt: null,
    });
    expect(() => process.kill(first.pid, 0)).toThrow();
  });
  it("rejects concurrent requests instead of building an unbounded queue", async () => {
    const w = worker();
    const abort = new AbortController();
    const pending = w.invoke("hang", 10, 2000, abort.signal);
    const rejection = expect(pending).rejects.toThrow("cancelled");
    await expect(w.invoke("another", 10, 2000, new AbortController().signal)).rejects.toThrow(
      "busy",
    );
    abort.abort();
    await rejection;
  });
  it("recovers after process failure without replaying the failed request", async () => {
    const w = worker();
    w.start();
    await expect(w.invoke("crash", 10, 2000, new AbortController().signal)).rejects.toThrow(
      "exited",
    );
    const next = await w.invoke("new", 10, 2000, new AbortController().signal);
    expect(JSON.parse(next.text).echo).toBe("new");
  });
  it("kills a timed out process", async () => {
    const w = worker();
    await expect(w.invoke("hang", 10, 100, new AbortController().signal)).rejects.toThrow(
      "timeout",
    );
    await w.stop();
    expect(w.snapshot().lastFailure?.code).toBe("local_worker_timeout");
  });
});
