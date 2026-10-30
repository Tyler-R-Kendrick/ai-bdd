/** Suggestions describe this browser's decoder, never the upload allowlist. */
export function mediaDecodeError(file: File, element: HTMLMediaElement) {
  const audio = file.type.startsWith('audio/');
  const extension = file.name.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase();
  const formats = audio
    ? [
        { extension: 'wav', label: 'WAV (PCM)', mime: 'audio/wav; codecs="1"' },
        { extension: 'mp3', label: 'MP3', mime: 'audio/mpeg' },
        {
          extension: 'ogg',
          label: 'Ogg (Vorbis)',
          mime: 'audio/ogg; codecs="vorbis"',
        },
      ]
    : [
        {
          extension: 'webm',
          label: 'WebM (VP8 or VP9)',
          mime: 'video/webm; codecs="vp8, vorbis"',
        },
        {
          extension: 'mp4',
          label: 'MP4 (H.264)',
          mime: 'video/mp4; codecs="avc1.42E01E"',
        },
      ];
  const supported = formats.filter(
    (format) =>
      format.extension !== extension && element.canPlayType(format.mime) !== '',
  );
  const selected = extension ? ` ${extension.toUpperCase()}` : ' media';
  return (
    `This browser cannot decode the selected${selected} file or its codec. ` +
    (supported.length
      ? `Try ${supported.map((format) => format.label).join(' or ')}, which this browser reports as supported.`
      : 'Try another browser with support for this codec, or re-encode the file for this browser.')
  );
}
