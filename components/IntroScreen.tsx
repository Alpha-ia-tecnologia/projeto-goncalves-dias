'use client';

import type { CSSProperties } from 'react';
import { DoorOpen, LoaderCircle } from 'lucide-react';

// The poet introduces himself line by line while the live study waits behind the veil.
const lines = [
  'Nasci em Caxias, no Maranhão, em 1823.',
  'Escrevi “Minha terra tem palmeiras, onde canta o Sabiá”.',
  'Hoje recebo você no meu gabinete, aqui na Escola Educa Prime.',
  'Fale comigo pela voz ou por escrito: eu escuto e respondo.',
];

// Each line is written at a reading pace; the next starts after a short breath.
const timing = lines.reduce<{ start: number; duration: number }[]>((list, line) => {
  const previous = list.at(-1);
  const start = previous ? previous.start + previous.duration + 0.3 : 1.4;
  return [...list, { start, duration: Math.max(1, line.length * 0.032) }];
}, []);

type Props = { ready: boolean; failed: boolean; leaving: boolean; onStart: () => void };

export default function IntroScreen({ ready, failed, leaving, onStart }: Props) {
  return (
    <section className={`intro-screen ${leaving ? 'is-leaving' : ''}`} aria-labelledby="intro-title">
      <div className="intro-veil" aria-hidden="true" />
      <div className="intro-body">
        <div className="intro-content">
          <h1 id="intro-title" className="intro-title">Gonçalves Dias</h1>
          <span className="intro-rule" aria-hidden="true" />
          <p className="intro-role">Poeta maranhense · 1823 – 1864</p>
          <div className="intro-lines">{lines.map((line, index) => <p key={line} style={{ '--line-start': `${timing[index].start}s`, '--line-duration': `${timing[index].duration}s` } as CSSProperties}>{line}</p>)}</div>
        </div>
        <div className="intro-action">
          <button type="button" className="intro-start" onClick={onStart} disabled={leaving}><DoorOpen size={24} strokeWidth={1.7} />Iniciar experiência</button>
          <span className="intro-status" role="status">{failed ? 'A visualização 3D não abriu, mas você já pode entrar.' : !ready && <><LoaderCircle size={14} className="spin" />Preparando o gabinete…</>}</span>
        </div>
        <footer className="intro-footer">
          <picture><source srcSet="/brand/educaprime-badge.webp" type="image/webp" /><img src="/brand/educaprime-badge.png" width={320} height={249} alt="Escola Educa Prime" /></picture>
          <p>Uma experiência da Escola Educa Prime. O poeta é uma representação artística, com voz gerada por IA.</p>
        </footer>
      </div>
    </section>
  );
}
