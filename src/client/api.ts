import { useMutation, useQueryClient } from '@tanstack/react-query';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function request<T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
  const form = body instanceof FormData;
  const response = await fetch(`/api${path}`, {
    credentials: 'include',
    ...(body !== undefined ? { method: 'POST', body: form ? body : JSON.stringify(body) } : {}),
    headers: { ...(body !== undefined && !form ? { 'Content-Type': 'application/json' } : {}), ...headers },
  });
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new ApiError(response.ok ? 'The server returned an invalid response. Please retry.' : `Request failed (${response.status})`, response.status);
  }
  if (!response.ok) {
    const error = result && typeof result === 'object' && 'error' in result ? result.error : undefined;
    throw new ApiError(typeof error === 'string' ? error : `Request failed (${response.status})`, response.status);
  }
  return result as T;
}

export interface Command { path: string; body: unknown; headers?: Record<string, string> }
export function useCommand() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ path, body, headers }: Command) => request<unknown>(path, body, headers),
    onSettled: () => client.invalidateQueries({ queryKey: ['dashboard'] }),
  });
}
