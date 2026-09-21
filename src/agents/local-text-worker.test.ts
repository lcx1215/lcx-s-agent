import { afterEach, describe, expect, it } from "vitest";
import { LocalTextWorker } from "./local-text-worker.js";
const workers: LocalTextWorker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
});
function worker() {
  const script = `require('node:readline').createInterface({input:process.stdin}).on('line', line => {
    const r=JSON.parse(line); if(r.prompt==='hang') return; if(r.prompt==='crash') process.exit(2);
    console.log(JSON.stringify({id:r.id,text:JSON.stringify({echo:r.prompt,pid:process.pid})}));
  });`;
  const result = new LocalTextWorker(process.execPath, ["-e", script]);
  workers.push(result);
  return result;
}
describe("resident local worker lifecycle", () => {
  it("reuses one process across batches and stops it with its host", async () => {
    const w = worker();
    w.start();
    const first = await w.invoke("one", 10, 2000, new AbortController().signal);
    const second = await w.invoke("two", 10, 2000, new AbortController().signal);
    expect(first.pid).toBe(second.pid);
    expect(JSON.parse(second.text).echo).toBe("two");
    await w.stop();
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
  });
});
