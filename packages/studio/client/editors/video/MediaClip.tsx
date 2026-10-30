import { useEffect, useRef } from 'react';
import type { VideoClip } from '../../../shared/video.ts';
import { activeClip, clipValue } from '../../../shared/video-timeline.ts';
export function MediaClip({ clip, time, playing, onError }: { clip: VideoClip; time: number; playing: boolean; onError: (message: string) => void }) {
  const video = useRef<HTMLVideoElement>(null), audio = useRef<HTMLAudioElement>(null), reported = useRef(false);
  useEffect(() => {
    for (const element of [video.current, audio.current]) {
      if (!element) continue;
      const active = activeClip(clip, time);
      if (element.readyState >= 1) {
        const target = Math.max(0, Math.min(element.duration - 0.00001, clip.mediaStart + time - clip.start));
        if (Math.abs(element.currentTime - target) > (playing ? 0.12 : 0.001)) element.currentTime = target;
      }
      element.volume = clip.muted ? 0 : Math.max(0, Math.min(1, clipValue(clip, 'volume', time)));
      if (playing && active && (element === video.current || !clip.muted)) {
        if (element.paused) void element.play().catch(() => {
          if (!reported.current) { reported.current = true; onError('The browser could not play this media. Check its format and press Play again.'); }
        });
      } else element.pause();
    }
  }, [clip, time, playing, onError]);
  useEffect(() => () => { video.current?.pause(); audio.current?.pause(); }, []);
  const error = () => onError(`“${clip.name}” could not be decoded. Reimport a browser-supported media file.`);
  return <>
    {clip.type === 'video' && <video ref={video} src={clip.src} muted playsInline preload="auto" onError={error} />}
    {(clip.type === 'audio' || (clip.type === 'video' && !clip.muted)) && <audio ref={audio} src={clip.src} preload="auto" onError={error} />}
  </>;
}
