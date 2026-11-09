import { useEffect, useRef, useState } from 'react';
import type { Brief } from '../schemas/brief';
import type { Platform } from '../schemas/common';
import type { Script, ScriptSet } from '../schemas/script';
import { formatClock, hasPlaceholders, splitPlaceholders, timedSections, type TimedSection } from './prompterMath';
import { Teleprompter } from './Teleprompter';

interface Question { id: string; text: string; example: string }
interface Result { set: ScriptSet; degraded: boolean; stats: { videosUsed: number; commentsMined: number } }
type Busy = 'intake' | 'generate' | null;

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'Request failed. Is the server running?');
  return data as T;
}

const PLATFORMS: { value: Platform; label: string }[] = [
  { value: 'instagram', label: 'Instagram Reels' },
  { value: 'tiktok', label: 'TikTok' },
];
const prettyHook = (h: string) => h.replace(/_/g, ' ');

function Spoken({ text }: { text: string }) {
  return (
    <>
      {splitPlaceholders(text).map((part, i) =>
        part.placeholder ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>,
      )}
    </>
  );
}

function Segment({ section }: { section: TimedSection }) {
  return (
    <div className="segment">
      <div className="segment-meta">
        <span className="segment-label">{section.label}</span>
        <span className="segment-time">{formatClock(section.start)}–{formatClock(section.end)}</span>
      </div>
      <p className={section.label === 'Hook' ? 'spoken spoken-hook' : 'spoken'}><Spoken text={section.text} /></p>
    </div>
  );
}

function ScriptView({ script, onRecord }: { script: Script; onRecord: () => void }) {
  const sections = timedSections(script);
  const opening = sections.filter((s) => s.inWindow);
  const rest = sections.filter((s) => !s.inWindow);

  return (
    <div className="script-layout">
      <article className="sheet">
        <header className="sheet-head">
          <div>
            <h3>{script.label}</h3>
            <p className="muted">{script.word_count_total} words · about {formatClock(script.est_seconds)} to say</p>
          </div>
          <button className="primary" onClick={onRecord}>Open teleprompter</button>
        </header>

        {hasPlaceholders(script) && <p className="fill-note">Replace the <mark>highlighted</mark> parts with your own details before recording.</p>}

        <div className="window-block">
          <p className="window-title">First 15 seconds <span>{script.word_count_window} words</span></p>
          {opening.map((s) => <Segment key={s.label} section={s} />)}
        </div>
        {rest.map((s) => <Segment key={s.label} section={s} />)}
      </article>

      <aside className="notes">
        <section>
          <h4>What to expect</h4>
          <p>{script.expected_response.profile}</p>
          <p className="benchmark">{script.expected_response.benchmark}</p>
          <p className="muted small">An estimate from similar videos, not a guarantee.</p>
        </section>
        <section>
          <h4>Why it should work</h4>
          <p>{script.why_it_works}</p>
        </section>
        <section>
          <h4>Best for</h4>
          <p>{script.best_for}</p>
        </section>
        <section>
          <h4>Watch out for</h4>
          <p>{script.risk}</p>
        </section>
        {script.on_screen_text.length > 0 && (
          <section>
            <h4>On-screen text</h4>
            <ul className="captions">{script.on_screen_text.map((t, i) => <li key={i}>{t}</li>)}</ul>
          </section>
        )}
      </aside>
    </div>
  );
}

function Working({ busy }: { busy: Exclude<Busy, null> }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);

  if (busy === 'intake') return <p className="working" role="status"><span className="dot" />Reading your brief…</p>;
  return (
    <div className="working-panel" role="status">
      <p className="working"><span className="dot" />Working on it <span className="clock">{formatClock(seconds)}</span></p>
      <p className="muted">We're finding popular videos on your topic, reading what viewers say in the comments, then writing and checking your scripts. This can take a few minutes, so keep this tab open.</p>
    </div>
  );
}

export function App() {
  const [platform, setPlatform] = useState<Platform>('instagram');
  const [text, setText] = useState('');
  const [brief, setBrief] = useState<Brief | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [result, setResult] = useState<Result | null>(null);
  const [active, setActive] = useState(0);
  const [recording, setRecording] = useState<Script | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const resultsRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (result) resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [result]);

  const generate = async (b: Brief, a: Record<string, string>) => {
    setBusy('generate');
    setError(null);
    setQuestions([]);
    try {
      setResult(await post<Result>('/api/generate', { brief: b, answers: a }));
      setActive(0);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const submit = async () => {
    setBusy('intake');
    setError(null);
    setResult(null);
    try {
      const r = await post<{ brief: Brief; questions: Question[] }>('/api/intake', { platform, text });
      setBrief(r.brief);
      setQuestions(r.questions);
      setAnswers({});
      if (r.questions.length === 0) await generate(r.brief, {});
      else setBusy(null);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  if (recording) return <Teleprompter script={recording} onExit={() => setRecording(null)} />;

  const current = result?.set.scripts[active] ?? result?.set.scripts[0];

  return (
    <main className="shell">
      <header className="brand">
        <span className="brand-dot" aria-hidden="true" />
        <span className="brand-name">ScriptGen</span>
      </header>

      <section className="composer">
        <h1>Scripts that keep people watching past the first 15 seconds.</h1>

        <div className="segmented" role="group" aria-label="Platform">
          {PLATFORMS.map((p) => (
            <button key={p.value} aria-pressed={platform === p.value} onClick={() => setPlatform(p.value)}>{p.label}</button>
          ))}
        </div>

        <label className="field">
          <span>What's your video about?</span>
          <textarea
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="I sell a $15 vitamin C serum for oily skin. It's for college students with breakouts and a small budget."
          />
        </label>
        <div className="composer-foot">
          <p className="muted">Say what you're showing, who it's for, the price and the niche. If something's missing, we'll ask.</p>
          <button className="primary large" disabled={!text.trim() || busy !== null} onClick={submit}>Write my scripts</button>
        </div>
      </section>

      {questions.length > 0 && brief && !busy && (
        <section className="followups">
          <h2>{questions.length > 1 ? 'Two quick questions' : 'One quick question'}</h2>
          {questions.map((q) => (
            <label className="field" key={q.id}>
              <span>{q.text}</span>
              <input value={answers[q.id] ?? ''} placeholder={q.example} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} />
            </label>
          ))}
          <div className="row">
            <button className="primary" onClick={() => generate(brief, answers)}>Write my scripts</button>
            <button className="ghost" onClick={() => generate(brief, {})}>Skip, use best guesses</button>
          </div>
        </section>
      )}

      {busy && <Working busy={busy} />}
      {error && <p className="error" role="alert">{error}</p>}

      {result && current && (
        <section className="results" ref={resultsRef}>
          <div className="results-head">
            <h2>Pick your script</h2>
            <p className="muted">Learned from {result.stats.videosUsed} popular videos and {result.stats.commentsMined} viewer comments.</p>
          </div>

          {result.degraded && <p className="muted">Some drafts didn't pass our quality checks, so we removed them.</p>}
          {result.set.assumptions.length > 0 && (
            <p className="assumptions">
              <span className="muted">We assumed</span>
              {result.set.assumptions.map((a) => <span className="chip" key={a.field}><b>{a.field}</b> {a.value}</span>)}
            </p>
          )}

          <div className="options">
            {result.set.scripts.map((s, i) => (
              <button className="option" key={i} aria-pressed={i === active} onClick={() => setActive(i)}>
                <span className="option-type">{prettyHook(s.hook_type)}</span>
                <span className="option-label">{s.label}</span>
                <span className="option-hook">{s.segments.hook}</span>
              </button>
            ))}
          </div>

          <ScriptView script={current} onRecord={() => setRecording(current)} />
        </section>
      )}
    </main>
  );
}
