import { uploadArtifactFile } from './hosting-upload.ts';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
async function rawApi<T = any>(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const res = await fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    headers:
      body === undefined || body instanceof FormData
        ? {}
        : { 'Content-Type': 'application/json' },
    ...(body === undefined
      ? {}
      : { body: body instanceof FormData ? body : JSON.stringify(body) }),
  });
  const value = await res
    .json()
    .catch(() => ({ error: 'The server returned an unreadable response' }));
  if (!res.ok)
    throw new ApiError(
      res.status,
      value.issues
        ? value.error +
          ': ' +
          value.issues.map((i: any) => `${i.path} ${i.message}`).join(', ')
        : (value.error ?? 'Request failed'),
    );
  return value;
}
export async function api<T = any>(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const upload = path.match(/^\/artifacts\/([0-9a-f-]{36})\/files$/i);
  if (method === 'POST' && upload && body instanceof FormData) {
    const file = body.get('file');
    if (file instanceof File)
      return uploadArtifactFile<T>(upload[1]!, file, rawApi);
  }
  return rawApi<T>(path, method, body);
}
export function download(
  name: string,
  data: BlobPart,
  mime = 'application/json',
) {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
export const date = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
