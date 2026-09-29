'use client';

import { useState } from 'react';
import { Footprints, Square, X } from 'lucide-react';
import { WALK_DESTINATIONS } from '../lib/avatar/walk-navigation';
import type { WalkStatus } from './AvatarStage';

type Props = {
  status: WalkStatus;
  onDestination(point: readonly [number, number]): void;
  onStop(): void;
  onReturn(): void;
  onClose(): void;
};

export default function WalkControls({ status, onDestination, onStop, onReturn, onClose }: Props) {
  const [destination, setDestination] = useState(WALK_DESTINATIONS[1]?.id ?? WALK_DESTINATIONS[0].id);
  const messages = {
    idle: 'Clique ou toque em um ponto livre do chão.',
    walking: 'Caminhando. Você pode escolher outro destino.',
    arrived: 'Cheguei. Podemos continuar nossa conversa aqui.',
    stopped: status.active ? 'Terminando o passo para parar.' : 'Passeio pausado. Escolha outro destino quando quiser.',
    blocked: 'Escolha um espaço livre, longe dos móveis e do quadro.',
  };
  return <section className="walk-controls" aria-label="Caminhar pelo gabinete" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onStop(); } }}>
    <div className="walk-controls-heading"><Footprints size={18} /><h2>Passear pelo gabinete</h2><button className="icon-button" type="button" onClick={onClose} aria-label="Fechar controles e parar caminhada"><X size={18} /></button></div>
    <p role="status" aria-live="polite">{messages[status.state]}</p>
    <form onSubmit={event => { event.preventDefault(); const selected = WALK_DESTINATIONS.find(item => item.id === destination); if (selected) onDestination(selected.position); }}>
      <label htmlFor="walk-destination">Escolha um destino</label>
      <div className="walk-destination-row"><select id="walk-destination" value={destination} onChange={event => setDestination(event.target.value as typeof destination)}>{WALK_DESTINATIONS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select><button type="submit">Ir</button></div>
    </form>
    <div className="walk-controls-footer"><button type="button" onClick={onStop} disabled={!status.active}><Square size={13} />Parar</button><button type="button" onClick={onReturn}>Voltar ao quadro</button></div>
  </section>;
}
