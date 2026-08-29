const apiUrl = process.env.API_BENCH_URL ?? "http://localhost:4000";
const siteId = process.env.API_BENCH_SITE_ID;
const floorId = process.env.API_BENCH_FLOOR_ID;
const cookie = process.env.API_BENCH_SESSION_COOKIE;
const samples = Number(process.env.API_BENCH_SAMPLES ?? 100);

if (!siteId || !floorId || !cookie) {
  throw new Error("API_BENCH_SITE_ID, API_BENCH_FLOOR_ID and API_BENCH_SESSION_COOKIE are required");
}
if (!Number.isInteger(samples) || samples < 20) throw new Error("API_BENCH_SAMPLES must be an integer of at least 20");

const durations = [];
for (let index = 0; index < samples; index += 1) {
  const startedAt = performance.now();
  const response = await fetch(
    `${apiUrl}/sites/${encodeURIComponent(siteId)}/floors/${encodeURIComponent(floorId)}/fixtures?limit=200`,
    { headers: { cookie } }
  );
  const duration = performance.now() - startedAt;
  if (!response.ok) throw new Error(`fixture API returned ${response.status}`);
  await response.arrayBuffer();
  durations.push(duration);
}

durations.sort((a, b) => a - b);
const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
const average = durations.reduce((sum, duration) => sum + duration, 0) / durations.length;
console.log(JSON.stringify({ samples, averageMs: Math.round(average), p95Ms: Math.round(p95) }, null, 2));
if (p95 > 1000) throw new Error(`fixture API p95 ${Math.round(p95)}ms exceeds 1000ms`);
