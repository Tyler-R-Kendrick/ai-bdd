import { useEffect, useRef, useState, type ReactNode } from 'react';

// A deliberately small Markdown vocabulary. Artifact messages never become HTML,
// execute embedded MDX, or load images from URLs supplied by a model.
function inline(text: string): ReactNode[] {
  const tokens =
    /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
  const output: ReactNode[] = [];
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = tokens.exec(text))) {
    if (match.index > start) output.push(text.slice(start, match.index));
    const value = match[0],
      key = match.index;
    if (value.startsWith('`'))
      output.push(<code key={key}>{value.slice(1, -1)}</code>);
    else if (value.startsWith('**'))
      output.push(<strong key={key}>{value.slice(2, -2)}</strong>);
    else if (value.startsWith('*'))
      output.push(<em key={key}>{value.slice(1, -1)}</em>);
    else {
      const link = value.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
      if (link)
        output.push(
          <a key={key} href={link[2]} target="_blank" rel="noreferrer noopener">
            {link[1]}
          </a>,
        );
      else output.push(value);
    }
    start = match.index + value.length;
  }
  if (start < text.length) output.push(text.slice(start));
  return output;
}

function CodeFence({
  language,
  content,
  onError,
}: {
  language: string;
  content: string;
  onError: (message: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    try {
      if (!navigator.clipboard)
        throw new Error(
          'Clipboard access is unavailable. Select and copy the code manually.',
        );
      await navigator.clipboard.writeText(content);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : 'Select and copy the code manually.',
      );
    }
  }
  return (
    <div className="message-code">
      <div>
        <span>{language || 'Code'}</span>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? 'Code copied' : 'Copy code'}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code>{content}</code>
      </pre>
    </div>
  );
}

export function MessageMarkdown({
  text,
  onError,
}: {
  text: string;
  onError: (message: string) => void;
}) {
  const lines = text.replace(/\r\n?/g, '\n').slice(0, 50000).split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;
  const listPattern = /^\s*(?:[-*+] |\d+[.)] )/;
  const isBoundary = (line: string) =>
    !line.trim() ||
    line.startsWith('```') ||
    /^#{1,6}\s/.test(line) ||
    listPattern.test(line);
  while (index < lines.length) {
    const line = lines[index]!,
      key = index;
    if (!line.trim()) {
      index++;
      continue;
    }
    if (line.startsWith('```')) {
      const language = line.slice(3).trim().slice(0, 40),
        code: string[] = [];
      index++;
      while (index < lines.length && !/^```\s*$/.test(lines[index]!))
        code.push(lines[index++]!);
      if (index < lines.length) index++;
      blocks.push(
        <CodeFence
          key={key}
          language={language}
          content={code.join('\n')}
          onError={onError}
        />,
      );
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      blocks.push(<h4 key={key}>{inline(line.replace(/^#{1,6}\s+/, ''))}</h4>);
      index++;
      continue;
    }
    if (listPattern.test(line)) {
      const ordered = /^\s*\d+[.)] /.test(line),
        items: ReactNode[] = [];
      while (
        index < lines.length &&
        listPattern.test(lines[index]!) &&
        /^\s*\d+[.)] /.test(lines[index]!) === ordered
      ) {
        items.push(
          <li key={index}>{inline(lines[index]!.replace(listPattern, ''))}</li>,
        );
        index++;
      }
      blocks.push(
        ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>,
      );
      continue;
    }
    const paragraph: string[] = [line];
    index++;
    while (index < lines.length && !isBoundary(lines[index]!))
      paragraph.push(lines[index++]!);
    blocks.push(<p key={key}>{inline(paragraph.join('\n'))}</p>);
  }
  return <>{blocks}</>;
}
