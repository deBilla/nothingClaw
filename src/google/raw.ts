// Generic "execute any method on this Google API client" helper. The agent
// passes a dotted method path (e.g. "events.list", "spreadsheets.values.get")
// and a params object, we resolve the function and call it.
//
// Safety: only own-property function descendants of the client are callable.
// The client object only exposes API resources, so this can't reach into
// arbitrary JS — but treat the input as trusted (it comes from the agent).

export async function callMethodPath(
  rootClient: unknown,
  methodPath: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const parts = methodPath.split('.').filter(Boolean);
  if (parts.length === 0) throw new Error('method path is required');

  let cursor: unknown = rootClient;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cursor === null || typeof cursor !== 'object') {
      throw new Error(`cannot traverse "${parts[i]}" on non-object`);
    }
    cursor = (cursor as Record<string, unknown>)[parts[i]!];
    if (cursor === undefined) {
      throw new Error(`unknown segment "${parts[i]}" in method path "${methodPath}"`);
    }
  }
  const fnName = parts[parts.length - 1]!;
  if (cursor === null || typeof cursor !== 'object') {
    throw new Error(`cannot call "${fnName}" on non-object`);
  }
  const fn = (cursor as Record<string, unknown>)[fnName];
  if (typeof fn !== 'function') {
    throw new Error(`"${methodPath}" is not a function on the client`);
  }
  const res = await (fn as (p: Record<string, unknown>) => Promise<{ data?: unknown }>).call(cursor, params);
  // googleapis methods return Gaxios responses with `.data`; surface just that.
  return res && typeof res === 'object' && 'data' in res ? (res as { data: unknown }).data : res;
}

export function rawToolDescription(serviceName: string, examples: string): string {
  return (
    `Call any method on the Google ${serviceName} API. Pass a dotted \`method\` path and a \`params\` object; ` +
    `the response data is returned as JSON. Use this for operations not covered by the dedicated ${serviceName.toLowerCase()}_* tools. ` +
    `Examples: ${examples}. Method paths mirror the googleapis Node library.`
  );
}

export function summarize(data: unknown, maxLen = 8000): string {
  let json: string;
  try {
    json = JSON.stringify(data, null, 2);
  } catch {
    json = String(data);
  }
  if (json.length <= maxLen) return json;
  return `${json.slice(0, maxLen)}\n... (truncated, total ${json.length} bytes)`;
}
