"use strict";
async function abortable(promise, signal) {
  if (!signal) return promise;
  let abort;
  const interrupted = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([promise, interrupted]); }
  finally { signal.removeEventListener("abort", abort); }
}
module.exports = { abortable };
