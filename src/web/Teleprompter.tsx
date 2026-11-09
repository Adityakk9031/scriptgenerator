import { useEffect, useRef, useState } from 'react';
import type { Script } from '../schemas/script';
import { ENGAGEMENT_WINDOW_SECONDS, formatClock, scriptSections, scrollPxPerSecond, splitPlaceholders } from './prompterMath';

const COUNTDOWN_FROM = 3;

export function Teleprompter({ script, onExit }: { script: Script; onExit: () => void }) {
  const [playing, setPlaying] = useState(false);
  const [finished, setFinished] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [fontSize, setFontSize] = useState(44);
  const [mirror, setMirror] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const position = useRef(0);

  const reset = () => {
    setPlaying(false);
    setFinished(false);
    setCountdown(null);
    setElapsed(0);
    position.current = 0;
    if (scroller.current) scroller.current.scrollTop = 0;
  };
  const toggle = () => {
    if (countdown !== null) return;
    if (playing) {
      setPlaying(false);
      return;
    }
    if (finished) reset();
    setCountdown(COUNTDOWN_FROM);
  };

  useEffect(() => {
    if (countdown === null) return;
    if (countdown === 0) {
      setCountdown(null);
      setPlaying(true);
      return;
    }
    const t = setTimeout(() => setCountdown(countdown - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setElapsed((e) => e + dt);
      const el = scroller.current;
      if (el) {
        const max = el.scrollHeight - el.clientHeight;
        position.current = Math.min(max, position.current + scrollPxPerSecond(max, script.est_seconds, speed) * dt);
        el.scrollTop = position.current;
        if (max > 0 && position.current >= max) {
          setPlaying(false);
          setFinished(true);
          return; // reached the last line: stop the clock too
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, script.est_seconds]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        e.preventDefault();
        toggle();
      } else if (e.key === 'Escape') {
        onExit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const inWindow = elapsed < ENGAGEMENT_WINDOW_SECONDS && !finished;
  const progress = finished ? 100 : Math.min(100, (elapsed / script.est_seconds) * 100);
  const windowMark = Math.min(100, (ENGAGEMENT_WINDOW_SECONDS / script.est_seconds) * 100);

  return (
    <div className="prompter">
      <div className="prompter-bar">
        <button className="ghost" onClick={onExit}>Back to scripts</button>
        <div className="prompter-actions">
          <button className="primary" onClick={toggle}>{playing ? 'Pause' : finished ? 'Start again' : 'Start'}</button>
          <button className="ghost" onClick={reset}>Restart</button>
        </div>
        <label className="control">
          <span>Speed <b>{speed.toFixed(1)}x</b></span>
          <input type="range" min="0.6" max="1.6" step="0.1" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
        </label>
        <label className="control">
          <span>Text size</span>
          <input type="range" min="24" max="80" step="2" value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))} />
        </label>
        <label className="toggle">
          <input type="checkbox" checked={mirror} onChange={(e) => setMirror(e.target.checked)} /> Mirror
        </label>
        <div className="prompter-clock">
          {inWindow && <span className="pill">First 15 seconds</span>}
          <span className="clock">{formatClock(elapsed)} / {formatClock(script.est_seconds)}</span>
        </div>
      </div>

      <div className="progress" aria-hidden="true">
        <span className="progress-fill" style={{ width: `${progress}%` }} />
        <i className="progress-mark" style={{ left: `${windowMark}%` }} />
      </div>

      <div className="prompter-stage">
        <div className="prompter-view" ref={scroller}>
          <div className="spacer-top" />
          <div className="prompter-text" style={{ fontSize, transform: mirror ? 'scaleX(-1)' : undefined }}>
            {scriptSections(script).map((s) => (
              <div key={s.label}>
                <p>
                  {splitPlaceholders(s.text).map((part, i) =>
                    part.placeholder ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>,
                  )}
                </p>
                {s.label === 'Hold' && <div className="window-end">15 seconds. Keep them here.</div>}
              </div>
            ))}
          </div>
          <div className="spacer-bottom" />
        </div>
        <div className="reading-line" aria-hidden="true" />
      </div>

      {countdown !== null && countdown > 0 && <div className="countdown">{countdown}</div>}
      <p className="prompter-hint">Space to start or pause. Esc to go back.</p>
    </div>
  );
}
