import { put } from '@vercel/blob/client';
/** Direct private uploads avoid the function request body limit. Completion stays authenticated. */
export async function uploadArtifactFile<T>(
  artifactId: string,
  file: File,
  request: <V>(path: string, method?: string, body?: unknown) => Promise<V>,
): Promise<T> {
  const capability = await request<{ adapter: string }>('/hosting/uploads');
  if (capability.adapter === 'multipart') {
    const form = new FormData();
    form.append('file', file);
    return request<T>(`/artifacts/${artifactId}/files`, 'POST', form);
  }
  if (capability.adapter !== 'direct-private-blob')
    throw new Error('The configured upload adapter is unavailable.');
  const grant = await request<{ id: string; pathname: string; token: string }>(
    `/artifacts/${artifactId}/uploads`,
    'POST',
    { name: file.name, byteSize: file.size, contentType: file.type },
  );
  await put(grant.pathname, file, {
    access: 'private',
    token: grant.token,
    contentType: file.type || 'application/octet-stream',
    multipart: file.size > 5 * 1024 * 1024,
  });
  return request<T>(`/hosting/uploads/${grant.id}/complete`, 'POST');
}
