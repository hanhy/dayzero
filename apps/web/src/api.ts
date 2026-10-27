export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const value = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(value?.error ?? `请求失败（${response.status}）`);
  return value as T;
}
const operations = new Map<string, string>();
export function operationId(key: string) {
  let id = operations.get(key);
  if (!id) {
    id = crypto.randomUUID();
    operations.set(key, id);
  }
  if (operations.size > 256) operations.delete(operations.keys().next().value!);
  return id;
}
export function mutation<T>(path: string, body: object, method = 'POST') {
  return api<T>(path, { method, body: JSON.stringify(body) });
}
export function downloadText(
  filename: string,
  text: string,
  type = 'application/json',
) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
