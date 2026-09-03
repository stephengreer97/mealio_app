(async () => {
  const seen = new Set();
  for (const e of performance.getEntriesByType('resource')) {
    if (!/digitaldevelopment/.test(e.name)) continue;
    seen.add(e.name.replace(/^https?:\/\/[^/]+/, ''));
  }
  return Array.from(seen).slice(0, 25);
})()
