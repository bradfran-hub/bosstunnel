"use strict";
async function* idleBody(body, controller, idleMs = 60000) {
  if (!Number.isSafeInteger(idleMs) || idleMs < 1 || idleMs > 2147483647) throw new Error("Invalid playback idle timeout");
  const reader = body.getReader();
  try {
    while (true) {
      const timer = setTimeout(() => controller.abort(Object.assign(new Error("Upstream playback stalled"), { code: "UPSTREAM_IDLE_TIMEOUT", status: 504 })), idleMs);
      let part;
      try { part = await reader.read(); }
      catch (error) { throw controller.signal.aborted ? controller.signal.reason : error; }
      finally { clearTimeout(timer); }
      if (part.done) return;
      // There is no upstream idle timer while downstream backpressure holds this yield.
      yield part.value;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
module.exports = { idleBody };
