export async function parseJsonSafe(r: Response): Promise<Record<string, unknown>> {
  const t = await r.text();
  if (!t) return {};
  try {
    return JSON.parse(t) as Record<string, unknown>;
  } catch {
    throw new Error(`Not JSON (HTTP ${r.status}): ${t.slice(0, 200)}`);
  }
}
