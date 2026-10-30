import {
  remoteRepositoryTools,
  type RemoteStreamState,
  type RemoteStreamPart,
} from './remote-agent.ts';
const names = new Set<string>(remoteRepositoryTools);
export function redactRemoteError(source: string): string {
  let text = source.slice(0, 50000);
  for (let i = 0; i < 4; i++) {
    const before = text;
    text = text.replace(
      /\\+(?:u\{([a-f\d]{1,6})\}|u([a-f\d]{4})|U([a-f\d]{8})|x([a-f\d]{2})|([0-7]{1,3}))/gi,
      (_, ...groups) => {
        const raw = groups.slice(0, 5).find((value) => value !== undefined);
        const number = parseInt(raw, groups[4] !== undefined ? 8 : 16);
        return number <= 0x10ffff ? String.fromCodePoint(number) : '?';
      },
    );
    text = text
      .replace(/%u([a-f\d]{4})/gi, (_, value) =>
        String.fromCodePoint(parseInt(value, 16)),
      )
      .replace(/(?:%[a-f\d]{2})+/gi, (value) => {
        try {
          return decodeURIComponent(value);
        } catch {
          return value;
        }
      });
    text = text.replace(
      /&(?:#x([a-f\d]+)|#(\d+)|(commat|colon|sol|bsol|Tab|NewLine));?/gi,
      (_, hex, decimal, named) =>
        hex || decimal
          ? String.fromCodePoint(
              Math.min(0x10ffff, parseInt(hex ?? decimal, hex ? 16 : 10)),
            )
          : ({
              commat: '@',
              colon: ':',
              sol: '/',
              bsol: '/',
              tab: '\t',
              newline: '\n',
            }[String(named).toLowerCase()] ?? ''),
    );
    if (text === before) break;
  }
  text = text.replace(/\\/g, '/').replace(/:\s*\/\s*\//g, '://');
  const prefixes = [
    ...text.matchAll(/(?:[a-z][a-z\d+.-]*:\/\/|(?:^|[\s"'(<[,:=])\/\/)/gi),
  ];
  for (const prefix of prefixes.reverse()) {
    const start = prefix.index! + prefix[0].length,
      window = text.slice(start, start + 8192),
      last = window.lastIndexOf('@');
    if (
      last >= 0 &&
      !(window.slice(0, last) === 'git' && /^ssh:/i.test(prefix[0]))
    )
      text = text.slice(0, start) + '[redacted]' + text.slice(start + last);
  }
  return text
    .replace(
      /\b(?:gh[pousr]_[a-z\d_]{10,}|xox[baprs]-[a-z\d-]{8,}|sk-[a-z\d_-]{12,})\b/gi,
      '[redacted]',
    )
    .replace(/\bBearer\s+[a-z\d._~+/-]{8,}/gi, 'Bearer [redacted]')
    .replace(
      /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|[a-z_]*proxy))\s*[:=]\s*(["'])([^\n]*?)\2/gi,
      '$1=$2[redacted]$2',
    )
    .replace(
      /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|[a-z_]*proxy))\s*[:=]\s*[^\s,;}]+/gi,
      '$1=[redacted]',
    );
}
function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 40) throw new Error('Tool error structure is too deeply nested');
  if (typeof value === 'string') return redactRemoteError(value);
  if (Array.isArray(value))
    return value.map((item) => redactValue(item, depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactValue(item, depth + 1),
      ]),
    );
  return value;
}
export function declaredRemoteTools(
  state: RemoteStreamState,
  values: string[],
): RemoteStreamState {
  if (values.some((value) => names.has(value)))
    throw new Error('Remote tools cannot impersonate server repository tools');
  if (state.calls.length)
    throw new Error('Declare remote tools before calling them');
  return { ...state, names: values };
}
/** Materialize display-only parts. Only the server's authenticated repository dispatcher may use origin=server. */
export function applyRemotePart(
  state: RemoteStreamState,
  part: RemoteStreamPart,
  origin: 'remote' | 'server' = 'remote',
): RemoteStreamState {
  const next = structuredClone(state);
  const block =
    'id' in part ? next.blocks.find((item) => item.id === part.id) : undefined;
  switch (part.type) {
    case 'stream-start':
      if (next.started) throw new Error('Stream already started');
      next.started = true;
      next.modelId = part.modelId;
      break;
    case 'text-start':
    case 'reasoning-start':
    case 'tool-input-start': {
      if (block || next.blocks.length >= 64)
        throw new Error('Stream block is duplicated or exceeds its budget');
      if (
        part.type === 'tool-input-start' &&
        !names.has(part.toolName) &&
        !next.names.includes(part.toolName)
      )
        throw new Error('Tool input names an undeclared tool');
      next.blocks.push({
        id: part.id,
        kind:
          part.type === 'text-start'
            ? 'text'
            : part.type === 'reasoning-start'
              ? 'reasoning'
              : 'tool-input',
        text: '',
        ended: false,
        ...(part.type === 'tool-input-start' ? { name: part.toolName } : {}),
      });
      break;
    }
    case 'text-delta':
    case 'reasoning-delta':
    case 'tool-input-delta': {
      const kind =
        part.type === 'text-delta'
          ? 'text'
          : part.type === 'reasoning-delta'
            ? 'reasoning'
            : 'tool-input';
      if (!block || block.ended || block.kind !== kind)
        throw new Error('Delta does not name an open matching block');
      block.text += part.delta;
      if (block.text.length > 50000)
        throw new Error('Stream block exceeds 50000 characters');
      break;
    }
    case 'text-end':
    case 'reasoning-end':
    case 'tool-input-end': {
      const kind =
        part.type === 'text-end'
          ? 'text'
          : part.type === 'reasoning-end'
            ? 'reasoning'
            : 'tool-input';
      if (!block || block.ended || block.kind !== kind)
        throw new Error('End does not name an open matching block');
      block.ended = true;
      break;
    }
    case 'tool-call': {
      if (
        origin === 'remote' &&
        (names.has(part.toolName) || !next.names.includes(part.toolName))
      )
        throw new Error('Remote tool call crossed the server tool boundary');
      if (origin === 'server' && !names.has(part.toolName))
        throw new Error('Unknown server repository tool');
      if (
        next.calls.some((call) => call.id === part.toolCallId) ||
        next.calls.length >= 64
      )
        throw new Error(
          'Tool call identity is duplicated or exceeds its budget',
        );
      next.calls.push({
        id: part.toolCallId,
        name: part.toolName,
        input: part.input,
        status: 'running',
        source: origin,
      });
      break;
    }
    case 'tool-result': {
      const call = next.calls.find((call) => call.id === part.toolCallId);
      if (
        !call ||
        call.name !== part.toolName ||
        call.source !== origin ||
        call.status !== 'running'
      )
        throw new Error('Tool result has no matching open call');
      if (JSON.stringify(part.result).length > 100000)
        throw new Error('Tool display result exceeds its budget');
      call.result = part.isError ? redactValue(part.result) : part.result;
      call.preliminary = part.preliminary;
      if (!part.preliminary)
        call.status = part.isError ? 'failed' : 'completed';
      break;
    }
    case 'finish-step':
      next.usage = part.usage;
      break;
    case 'finish':
      next.finishReason = part.finishReason;
      next.usage = part.totalUsage;
      break;
    case 'error':
      next.error = redactRemoteError(part.error);
      break;
  }
  if (JSON.stringify(next).length > 256000)
    throw new Error('Persisted stream exceeds its 256 kB display budget');
  return next;
}
