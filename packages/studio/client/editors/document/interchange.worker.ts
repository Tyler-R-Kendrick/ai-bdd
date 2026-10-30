import {
  exportDocx,
  importDocx,
  importMarkdown,
} from '../../../shared/document-interchange.ts';
self.addEventListener('message', (event: MessageEvent) => {
  try {
    const input = event.data;
    if (input.operation === 'import') {
      const result =
        input.format === 'docx'
          ? importDocx(new Uint8Array(input.bytes))
          : importMarkdown(input.source, input.format === 'mdx');
      self.postMessage({ ok: true, result });
    } else if (input.operation === 'export-docx') {
      const bytes = exportDocx(input.doc, input.title, input.images);
      self.postMessage({ ok: true, bytes }, { transfer: [bytes.buffer] });
    } else throw new Error('Unsupported document operation');
  } catch (error) {
    self.postMessage({ ok: false, error: (error as Error).message });
  }
});
