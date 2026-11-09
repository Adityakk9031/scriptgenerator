import type { Script } from '../schemas/script';

export const ENGAGEMENT_WINDOW_SECONDS = 15;
const WORDS_PER_SECOND = 2.5;

export interface PrompterSection {
  label: string;
  text: string;
}

export interface TimedSection extends PrompterSection {
  start: number;
  end: number;
  /** Part of the hook + hold block that has to earn the first 15 seconds. */
  inWindow: boolean;
}

export function scriptSections(s: Script): PrompterSection[] {
  return [
    { label: 'Hook', text: s.segments.hook },
    { label: 'Hold', text: s.segments.hold },
    ...s.segments.body.map((text, i) => ({ label: `Body ${i + 1}`, text })),
    { label: 'Close', text: s.segments.close },
  ];
}

const countWords = (text: string): number => text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/** When each section is actually spoken, worked out from its own word count. */
export function timedSections(s: Script): TimedSection[] {
  let words = 0;
  return scriptSections(s).map((section) => {
    const start = words / WORDS_PER_SECOND;
    words += countWords(section.text);
    return { ...section, start, end: words / WORDS_PER_SECOND, inWindow: section.label === 'Hook' || section.label === 'Hold' };
  });
}

export interface TextPart {
  text: string;
  placeholder: boolean;
}

/** Splits spoken text so [things the creator must fill in] can be highlighted. */
export function splitPlaceholders(text: string): TextPart[] {
  return text
    .split(/(\[[^\]]+\])/)
    .filter((p) => p !== '')
    .map((p) => ({ text: p, placeholder: /^\[[^\]]+\]$/.test(p) }));
}

export const hasPlaceholders = (s: Script): boolean => scriptSections(s).some((x) => splitPlaceholders(x.text).some((p) => p.placeholder));

/** Pixels per second so the whole text passes in the script's duration; speed 1 = normal, 1.5 = 50% faster. */
export function scrollPxPerSecond(scrollableHeight: number, durationSec: number, speed: number): number {
  if (scrollableHeight <= 0 || durationSec <= 0 || speed <= 0) return 0;
  return (scrollableHeight / durationSec) * speed;
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
