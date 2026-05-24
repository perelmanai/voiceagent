"use client";

import { memo, useEffect, useRef } from "react";

type Props = {
  stream: MediaStream | null;
  active: boolean;
};

const BAR_COUNT = 96;
const SILENCE_THRESHOLD = 0.04;

function WaveformImpl({ stream, active }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bufferRef = useRef<number[]>(new Array(BAR_COUNT).fill(0));
  const rafRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  useEffect(() => {
    if (!stream) {
      analyserRef.current = null;
      sourceRef.current?.disconnect();
      sourceRef.current = null;
      return;
    }

    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    const ctx = new Ctx();
    audioCtxRef.current = ctx;
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.7;
    source.connect(analyser);
    sourceRef.current = source;
    analyserRef.current = analyser;

    return () => {
      try {
        source.disconnect();
      } catch {}
      try {
        ctx.close();
      } catch {}
      analyserRef.current = null;
      sourceRef.current = null;
      audioCtxRef.current = null;
    };
  }, [stream]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;

    const sampleBuffer = new Uint8Array(256);

    const draw = () => {
      const analyser = analyserRef.current;
      const buf = bufferRef.current;

      let amp = 0;
      if (analyser && active) {
        analyser.getByteTimeDomainData(sampleBuffer);
        let sum = 0;
        for (let i = 0; i < sampleBuffer.length; i++) {
          const v = (sampleBuffer[i] - 128) / 128;
          sum += v * v;
        }
        amp = Math.sqrt(sum / sampleBuffer.length);
        amp = Math.min(1, amp * 2.4);
      } else {
        amp = 0;
      }

      buf.shift();
      buf.push(amp);

      const w = canvas.width;
      const h = canvas.height;
      ctx2d.clearRect(0, 0, w, h);

      const barW = (w / BAR_COUNT) * 0.55;
      const gap = w / BAR_COUNT - barW;
      const cy = h / 2;

      for (let i = 0; i < BAR_COUNT; i++) {
        const v = buf[i];
        const active = v > SILENCE_THRESHOLD;
        const minH = 2 * dpr;
        const barH = Math.max(minH, v * h * 0.85);
        const x = i * (barW + gap);

        if (active) {
          const intensity = Math.min(1, v * 1.8);
          ctx2d.fillStyle = `rgba(247, 109, 86, ${0.45 + 0.55 * intensity})`;
        } else {
          ctx2d.fillStyle = "rgba(255, 232, 220, 0.12)";
        }

        ctx2d.beginPath();
        const r = barW / 2;
        ctx2d.roundRect(x, cy - barH / 2, barW, barH, r);
        ctx2d.fill();
      }

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      ro.disconnect();
    };
  }, [active]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full block"
      aria-hidden="true"
    />
  );
}

export const Waveform = memo(WaveformImpl);
