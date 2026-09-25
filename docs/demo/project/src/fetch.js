const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// `sleep` is injectable so tests can record the delays without waiting on them.
export async function withRetry(fn, { retries = 3, baseDelayMs = 200, sleep = defaultSleep } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < retries) await sleep(baseDelayMs);
    }
  }
  throw lastError;
}

export async function fetchJson(url, options) {
  return withRetry(async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
  }, options);
}
