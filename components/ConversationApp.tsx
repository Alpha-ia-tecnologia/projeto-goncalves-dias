'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUp, ArrowUpRight, BookOpen, Check, ChevronRight, CircleHelp, Focus, Hand, LoaderCircle, Mic, RotateCcw, Settings2, Sparkles, Square, UserRound, Volume2, VolumeX, X } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import AvatarStage, { type AvatarHandle } from './AvatarStage';
import { SpeechPlayer, type MouthFrame } from '../lib/audio';
import { getDemoReply } from '../lib/demo';

type Phase = 'idle' | 'thinking' | 'preparing' | 'speaking' | 'requesting' | 'recording' | 'transcribing';
type ServiceStatus = { deepseek: boolean; openai: boolean; model: string; voice: string; mode: 'live' | 'demo' };
type Message = { id: string; role: 'user' | 'assistant'; text: string; demo?: boolean };
type Gesture = 'wave' | 'nod' | 'none';
const welcome: Message = { id: 'welcome', role: 'assistant', text: 'Olá, seja bem-vindo. Sou uma representação digital de Gonçalves Dias. Podemos conversar sobre poesia, memória e imaginação. Por onde começamos?' };
const phases: Record<Phase, string> = { idle: 'Pronto para conversar', thinking: 'Preparando uma resposta', preparing: 'Preparando a voz', speaking: 'Falando com você', requesting: 'Aguardando permissão do microfone', recording: 'Ouvindo você', transcribing: 'Entendendo sua mensagem' };

function conversationHistory(messages: Message[]) {
  const turns: { role: Message['role']; content: string }[][] = [];
  for (const message of messages) {
    if (message.id === 'welcome') continue;
    if (message.role === 'user') turns.push([{ role: message.role, content: message.text }]);
    else if (turns.at(-1)?.length === 1) turns.at(-1)!.push({ role: message.role, content: message.text });
  }
  const history: { role: Message['role']; content: string }[] = [];
  let characters = 0;
  for (const turn of turns.reverse()) {
    // Keep complete exchanges; cancelled or failed user messages have no reply.
    if (turn.length !== 2) continue;
    const length = turn.reduce((sum, message) => sum + message.content.length, 0);
    if (history.length + turn.length > 12 || characters + length > 10_000) break;
    history.unshift(...turn);
    characters += length;
  }
  return history;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readError(response: Response, fallback: string): Promise<Error> {
  try {
    const body: unknown = await response.json();
    return new Error(isObject(body) && isObject(body.error) && typeof body.error.message === 'string' ? body.error.message : fallback);
  } catch { return new Error(fallback); }
}

export default function ConversationApp() {
  const avatar = useRef<AvatarHandle>(null);
  const player = useRef<SpeechPlayer | null>(null);
  const abort = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const microphone = useRef<MediaStream | null>(null);
  const recordTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const lastSpeech = useRef<{ bytes: ArrayBuffer; gesture: Gesture; messageId: string } | null>(null);
  const lastLevelUpdate = useRef(0);
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [messages, setMessages] = useState<Message[]>([welcome]);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [modelError, setModelError] = useState('');
  const [view, setView] = useState<'portrait' | 'full'>('portrait');
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const voiceEnabledRef = useRef(true);
  const [motionEnabled, setMotionEnabled] = useState(true);
  const [level, setLevel] = useState(0);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [lastSpokenId, setLastSpokenId] = useState('');
  const [modal, setModal] = useState<'settings' | 'about'>('settings');
  const [avatarVersion, setAvatarVersion] = useState(0);
  const demoMode = status?.mode !== 'live';
  const busy = phase !== 'idle';

  const refreshStatus = useCallback(async () => {
    try {
      const response = await fetch('/api/status', { cache: 'no-store' });
      if (!response.ok) throw new Error('Status indisponível');
      const body: unknown = await response.json();
      if (!isObject(body) || typeof body.deepseek !== 'boolean' || typeof body.openai !== 'boolean'
        || typeof body.model !== 'string' || typeof body.voice !== 'string' || (body.mode !== 'live' && body.mode !== 'demo')) {
        throw new Error('Status inválido');
      }
      setStatus({ deepseek: body.deepseek, openai: body.openai, model: body.model, voice: body.voice, mode: body.mode });
      setStatusError(false);
    } catch { setStatusError(true); }
  }, []);

  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const initialFrame = requestAnimationFrame(() => {
      void refreshStatus();
      setMotionEnabled(!reducedMotion.matches);
    });
    const onFocus = () => { void refreshStatus(); };
    window.addEventListener('focus', onFocus);
    player.current = new SpeechPlayer((frame: MouthFrame) => {
      avatar.current?.setMouth(frame);
      const now = performance.now();
      if (now - lastLevelUpdate.current > 80 || frame.level === 0) {
        lastLevelUpdate.current = now;
        setLevel(frame.level);
      }
    });
    return () => {
      cancelAnimationFrame(initialFrame);
      sequence.current += 1;
      abort.current?.abort();
      player.current?.dispose();
      if (recorder.current?.state === 'recording') recorder.current.stop();
      microphone.current?.getTracks().forEach(track => track.stop());
      if (recordTimer.current) clearInterval(recordTimer.current);
      recorder.current = null;
      microphone.current = null;
      recordTimer.current = null;
      window.removeEventListener('focus', onFocus);
    };
  }, [refreshStatus]);

  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [messages, phase]);
  const onAvatarReady = useCallback(() => { setReady(true); setModelError(''); }, []);
  const onAvatarError = useCallback((message: string) => { setModelError(message); setReady(false); }, []);

  function openModal(kind: 'settings' | 'about') {
    setModal(kind);
    dialog.current?.showModal();
  }

  function stop() {
    sequence.current += 1;
    abort.current?.abort();
    abort.current = null;
    player.current?.stop();
    if (recorder.current?.state === 'recording') recorder.current.stop();
    recorder.current = null;
    microphone.current?.getTracks().forEach(track => track.stop());
    microphone.current = null;
    if (recordTimer.current) clearInterval(recordTimer.current);
    recordTimer.current = null;
    setPhase('idle');
    setLevel(0);
  }

  function toggleVoice() {
    const enabled = !voiceEnabledRef.current;
    voiceEnabledRef.current = enabled;
    setVoiceEnabled(enabled);
    if (!enabled) {
      player.current?.stop();
      setLevel(0);
      // Keep the pending text response; cancel speech work immediately.
      if (phase === 'preparing' || phase === 'speaking') stop();
    }
  }

  async function sendMessage(raw: string) {
    const message = raw.trim();
    if (!message || message.length > 2000 || !status || !ready) return;
    stop();
    const current = ++sequence.current;
    const controller = new AbortController();
    abort.current = controller;
    setError('');
    setInput('');
    setPhase('thinking');
    setLastSpokenId('');
    lastSpeech.current = null;
    const history = conversationHistory(messages);
    setMessages(previous => [...previous, { id: crypto.randomUUID(), role: 'user', text: message }]);
    // Start/resume audio within the original user interaction, before network awaits.
    if (voiceEnabledRef.current) await player.current?.unlock().catch(() => undefined);
    if (current !== sequence.current) return;
    let responseReceived = false;
    let replyGesture: Gesture = 'none';
    try {
      let text: string;
      let demoAudio = '';
      if (demoMode) {
        const reply = getDemoReply(message);
        text = reply.text;
        replyGesture = reply.gesture;
        demoAudio = reply.audio;
      } else {
        const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, history }), signal: controller.signal });
        if (!response.ok) throw await readError(response, 'Não foi possível preparar uma resposta. Tente novamente.');
        const reply: unknown = await response.json();
        if (!isObject(reply) || typeof reply.text !== 'string' || !reply.text.trim()
          || (reply.gesture !== 'wave' && reply.gesture !== 'nod' && reply.gesture !== 'none')) {
          throw new Error('A resposta veio incompleta. Tente novamente.');
        }
        text = reply.text;
        replyGesture = reply.gesture;
      }
      if (current !== sequence.current) return;
      responseReceived = true;
      const messageId = crypto.randomUUID();
      setMessages(previous => [...previous, { id: messageId, role: 'assistant', text, demo: demoMode }]);
      if (!voiceEnabledRef.current) {
        if (replyGesture !== 'none') avatar.current?.gesture(replyGesture);
        setPhase('idle');
        return;
      }
      setPhase('preparing');
      const response = demoMode
        ? await fetch(demoAudio, { signal: controller.signal })
        : await fetch('/api/speech', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: controller.signal });
      if (!response.ok) throw await readError(response, 'A resposta está no texto, mas não foi possível gerar a voz.');
      const bytes = await response.arrayBuffer();
      if (current !== sequence.current) return;
      if (!voiceEnabledRef.current) { setPhase('idle'); return; }
      lastSpeech.current = { bytes, gesture: replyGesture, messageId };
      setLastSpokenId(messageId);
      await player.current?.play(bytes, () => {
        if (current !== sequence.current || !voiceEnabledRef.current) return;
        setPhase('speaking');
        if (replyGesture !== 'none') avatar.current?.gesture(replyGesture);
      });
      if (current === sequence.current) setPhase('idle');
    } catch (failure) {
      if (current !== sequence.current || controller.signal.aborted) return;
      if (responseReceived && replyGesture !== 'none') avatar.current?.gesture(replyGesture);
      setError(failure instanceof Error ? failure.message : 'Não foi possível concluir. Tente novamente.');
      setPhase('idle');
      player.current?.stop();
    }
  }

  async function replay() {
    const saved = lastSpeech.current;
    if (!saved || !ready || !voiceEnabledRef.current) return;
    stop();
    const current = ++sequence.current;
    setError('');
    setPhase('preparing');
    try {
      await player.current?.play(saved.bytes, () => {
        if (current !== sequence.current || !voiceEnabledRef.current) return;
        setPhase('speaking');
        if (saved.gesture !== 'none') avatar.current?.gesture(saved.gesture);
      });
      if (current === sequence.current) setPhase('idle');
    } catch { if (current === sequence.current) { player.current?.stop(); setError('Não foi possível reproduzir a voz. Tente novamente.'); setPhase('idle'); } }
  }

  function finishRecording() {
    const capture = recorder.current;
    if (capture?.state !== 'recording') return;
    setPhase('transcribing');
    capture.stop();
  }

  async function startRecording() {
    if (!ready) return;
    if (!status?.openai || demoMode) { openModal('settings'); return; }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { setError('Este navegador não oferece gravação de áudio. Você pode conversar por texto.'); return; }
    stop();
    setError('');
    setPhase('requesting');
    const current = ++sequence.current;
    let ownedStream: MediaStream | null = null;
    let ownedCapture: MediaRecorder | null = null;
    let ownedTimer: ReturnType<typeof setInterval> | null = null;
    const releaseCapture = () => {
      if (ownedTimer) clearInterval(ownedTimer);
      if (recordTimer.current === ownedTimer) recordTimer.current = null;
      ownedTimer = null;
      ownedStream?.getTracks().forEach(track => track.stop());
      if (microphone.current === ownedStream) microphone.current = null;
      if (recorder.current === ownedCapture) recorder.current = null;
    };
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      ownedStream = stream;
      if (current !== sequence.current) { releaseCapture(); return; }
      microphone.current = stream;
      const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(value => MediaRecorder.isTypeSupported(value));
      const capture = new MediaRecorder(stream, { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: 64_000 });
      ownedCapture = capture;
      recorder.current = capture;
      const chunks: Blob[] = [];
      let recordedBytes = 0;
      capture.ondataavailable = event => {
        if (current !== sequence.current || !event.data.size) return;
        chunks.push(event.data);
        recordedBytes += event.data.size;
        if (recordedBytes > 8 * 1024 * 1024 && capture.state === 'recording') capture.stop();
      };
      capture.onerror = () => {
        if (current !== sequence.current) { releaseCapture(); return; }
        stop();
        releaseCapture();
        setError('A gravação foi interrompida. Tente novamente ou digite sua mensagem.');
      };
      capture.onstop = async () => {
        releaseCapture();
        if (current !== sequence.current) return;
        const blob = new Blob(chunks, { type: capture.mimeType || 'audio/webm' });
        if (blob.size < 500) { setPhase('idle'); setError('A gravação ficou muito curta. Tente falar por mais alguns segundos.'); return; }
        if (blob.size > 8 * 1024 * 1024) { setPhase('idle'); setError('A gravação ultrapassou 8 MB. Envie uma fala mais curta.'); return; }
        const controller = new AbortController();
        abort.current = controller;
        setPhase('transcribing');
        try {
          const form = new FormData();
          form.append('audio', blob, blob.type.includes('mp4') ? 'mensagem.mp4' : 'mensagem.webm');
          const response = await fetch('/api/transcribe', { method: 'POST', body: form, signal: controller.signal });
          if (!response.ok) throw await readError(response, 'Não foi possível entender o áudio. Tente novamente.');
          const body: unknown = await response.json();
          if (current !== sequence.current) return;
          if (!isObject(body) || typeof body.text !== 'string' || !body.text.trim()) { setPhase('idle'); setError('Não identifiquei uma fala. Tente novamente.'); return; }
          if (body.text.trim().length > 2000) { setPhase('idle'); setError('A gravação ficou longa. Envie uma fala mais curta.'); return; }
          await sendMessage(body.text);
        } catch (failure) {
          if (current !== sequence.current || controller.signal.aborted) return;
          setError(failure instanceof Error ? failure.message : 'Não foi possível transcrever o áudio.');
          setPhase('idle');
        }
      };
      capture.onstart = () => {
        if (current !== sequence.current || capture.state !== 'recording') return;
        const startedAt = performance.now();
        ownedTimer = setInterval(() => {
          if (current !== sequence.current) { releaseCapture(); return; }
          const seconds = Math.floor((performance.now() - startedAt) / 1000);
          setRecordSeconds(Math.min(seconds, 25));
          if (seconds >= 25 && capture.state === 'recording') {
            setPhase('transcribing');
            capture.stop();
          }
        }, 250);
        recordTimer.current = ownedTimer;
      };
      setRecordSeconds(0);
      capture.start(250);
      setPhase('recording');
    } catch {
      releaseCapture();
      if (current === sequence.current) {
        setError('Não foi possível acessar o microfone. Permita o acesso no navegador ou digite sua mensagem.');
        setPhase('idle');
      }
    }
  }

  function submit(event: FormEvent) { event.preventDefault(); if (!busy) void sendMessage(input); }
  function clearChat() { stop(); setMessages([welcome]); setError(''); setLastSpokenId(''); lastSpeech.current = null; }

  return (
    <div className="app-shell">
      <header className="site-header">
        <Link href="/" className="wordmark" aria-label="Gonçalves Dias, início"><span className="monogram">gd<span>.</span></span><span className="wordmark-text">Gonçalves Dias<small>PRESENÇA DIGITAL</small></span></Link>
        <nav className="header-actions" aria-label="Navegação principal">
          <button className="quiet-button how-button" onClick={() => openModal('about')}><CircleHelp size={16} /> Como funciona</button>
          <span className={`connection-pill ${!demoMode ? 'connected' : ''}`}><span className="status-dot" />{!status ? 'Verificando conexão' : demoMode ? 'Demonstração' : 'Conectado'}</span>
          <button className="icon-button settings-button" aria-label="Configurar conexões" onClick={() => openModal('settings')}><Settings2 size={19} /></button>
        </nav>
      </header>

      <main>
        <section className="intro" aria-labelledby="page-title">
          <div><p className="eyebrow"><span /> LITERATURA, AGORA PRESENTE</p><h1 id="page-title">Uma conversa através do <em>tempo.</em></h1></div>
          <p className="intro-copy">Uma presença em 3D que escuta, conversa<br className="desktop-break" /> e responde com voz e gestos.</p>
        </section>

        <div className="experience-grid">
          <section className="stage-card" aria-label="Personagem 3D interativo">
            <div className="stage-top"><div><span className="stage-label">SEU ANFITRIÃO</span><h2>Gonçalves Dias</h2></div><span className="live-caption"><span className={`status-dot ${busy ? 'pulsing' : ''}`} />{ready ? phases[phase] : modelError ? 'Visualização indisponível' : 'Preparando o personagem'}</span></div>
            <div className="stage-backdrop" aria-hidden="true"><div className="stage-orbit orbit-one" /><div className="stage-orbit orbit-two" /><span>G.</span></div>
            <div className="stage-view">
              <AvatarStage key={avatarVersion} ref={avatar} view={view} motionEnabled={motionEnabled} onReady={onAvatarReady} onError={onAvatarError} />
              {!ready && <div className="avatar-loading"><Image src="/models/avatar-poster.webp" alt="Retrato de Gonçalves Dias" width={640} height={800} unoptimized /><div className="loading-label">{modelError ? <><span>Não foi possível abrir a visualização 3D.</span><button className="small-button" onClick={() => { setModelError(''); setAvatarVersion(value => value + 1); }}>Tentar novamente</button></> : <><LoaderCircle size={17} className="spin" /><span>Preparando sua presença…</span></>}</div></div>}
            </div>
            <div className="stage-bottom">
              <div className="view-control" aria-label="Enquadramento do personagem"><button className={view === 'portrait' ? 'selected' : ''} aria-pressed={view === 'portrait'} onClick={() => setView('portrait')} title="Aproximar rosto"><Focus size={17} /><span>Retrato</span></button><button className={view === 'full' ? 'selected' : ''} aria-pressed={view === 'full'} onClick={() => setView('full')} title="Ver corpo inteiro"><UserRound size={17} /><span>Corpo inteiro</span></button></div>
              <div className="stage-tools"><button className="icon-button" aria-label="Restaurar enquadramento" onClick={() => avatar.current?.resetView()}><RotateCcw size={17} /></button><button className={`icon-button ${!motionEnabled ? 'muted-control' : ''}`} aria-label={motionEnabled ? 'Desativar gestos automáticos' : 'Ativar gestos automáticos'} aria-pressed={motionEnabled} onClick={() => setMotionEnabled(value => !value)}><Hand size={18} /></button></div>
            </div>
            <div className="stage-caption"><span className="waveform" aria-hidden="true">{[.5,.8,1,.7,.9,.45].map((height,index) => <i key={index} style={{ height: `${4 + level * 20 * height}px` }} />)}</span><span>{phase === 'speaking' ? 'Voz e movimento em sintonia' : 'Arraste para explorar · Role para aproximar'}</span></div>
          </section>

          <section className="chat-card" aria-label="Conversa com o personagem">
            <header className="chat-header"><div className="chat-symbol"><Sparkles size={20} /></div><div><h2>Vamos conversar?</h2><p>Uma ideia pode atravessar séculos.</p></div><button className="icon-button" onClick={clearChat} aria-label="Limpar conversa e começar novamente" title="Nova conversa"><RotateCcw size={16} /></button></header>
            {(demoMode || statusError) && <div className="demo-notice"><div><span className="notice-dot" /><strong>{statusError ? 'Conexão indisponível' : 'Uma prévia para você explorar'}</strong><p>{statusError ? 'Verifique a conexão para continuar.' : 'Respostas prontas e voz local. Conecte as APIs para conversar livremente.'}</p></div><button onClick={() => openModal('settings')} aria-label="Configurar as conexões"><ArrowUpRight size={18} /></button></div>}
            <div className="messages" role="log" aria-label="Histórico da conversa" aria-live="polite" aria-relevant="additions text">
              <div className="conversation-date"><span /> A CONVERSA COMEÇA AQUI <span /></div>
              {messages.map(message => <article key={message.id} className={`message message-${message.role}`}><div className="message-meta">{message.role === 'assistant' ? <><span className="mini-monogram">g.</span>Gonçalves Dias{message.demo && <span className="demo-tag">prévia</span>}</> : 'Você'}</div><div className="message-text">{message.text}</div>{message.id === lastSpokenId && <button className="replay-button" disabled={busy || !ready || !voiceEnabled} onClick={() => void replay()}><Volume2 size={13} /> Ouvir novamente</button>}</article>)}
              {(phase === 'thinking' || phase === 'transcribing') && <div className="typing-indicator" aria-label={phases[phase]}><span /><span /><span /><small>{phase === 'transcribing' ? 'Entendendo sua mensagem…' : 'Um instante…'}</small></div>}
              <div ref={chatEnd} />
            </div>
            <div className="chat-bottom">
              {messages.length < 3 && <div className="suggestions" aria-label="Sugestões de conversa">{[{text:'Olá, tudo bem?',icon:Hand},{text:'Fale sobre poesia',icon:BookOpen}].map(({text,icon:Icon}) => <button key={text} disabled={busy || !status || !ready} onClick={() => void sendMessage(text)}><Icon size={14} />{text}<ChevronRight size={13} /></button>)}</div>}
              {error && <div className="error-notice" role="alert"><span>{error}</span><button aria-label="Fechar aviso" onClick={() => setError('')}><X size={14} /></button></div>}
              {busy && <div className="activity-row"><span>{phase === 'recording' ? `Gravando · ${recordSeconds}s / 25s` : phases[phase]}</span><button onClick={phase === 'recording' ? finishRecording : stop}><Square size={11} fill="currentColor" />{phase === 'recording' ? 'Enviar áudio' : 'Interromper'}</button></div>}
              <form onSubmit={submit} className={`composer ${phase === 'recording' ? 'recording' : ''}`}>
                <label htmlFor="message-input" className="sr-only">Sua mensagem para Gonçalves Dias</label>
                <textarea id="message-input" placeholder="Diga olá ou compartilhe uma ideia…" value={input} onChange={event => setInput(event.target.value)} maxLength={2000} rows={2} disabled={busy || !status || !ready} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!busy) void sendMessage(input); } }} />
                <div className="composer-toolbar"><button type="button" className={`icon-button mic-button ${phase === 'recording' ? 'recording' : ''}`} disabled={(busy && phase !== 'recording') || !status || !ready} aria-label={phase === 'recording' ? 'Parar gravação e enviar' : demoMode ? 'Configurar voz para usar o microfone' : 'Gravar mensagem de voz'} onClick={phase === 'recording' ? finishRecording : () => void startRecording()}>{phase === 'recording' ? <Square size={17} /> : <Mic size={18} />}</button><span>{phase === 'recording' ? 'Estou ouvindo…' : 'Enter para enviar'}</span><button className="send-button" type="submit" disabled={busy || !input.trim() || !status || !ready} aria-label="Enviar mensagem"><ArrowUp size={20} /></button></div>
              </form>
              <div className="audio-disclosure"><button onClick={toggleVoice} aria-pressed={voiceEnabled}>{voiceEnabled ? <Volume2 size={13} /> : <VolumeX size={13} />}{voiceEnabled ? 'Voz ativada' : 'Só texto'}</button><span>Voz {demoMode ? 'local de demonstração' : 'gerada por IA'}</span></div>
            </div>
          </section>
        </div>
        <footer className="page-footer"><span>Uma interpretação artística. Uma nova forma de conversar.</span><button onClick={() => openModal('about')}>Conheça a experiência <ArrowUpRight size={13} /></button></footer>
      </main>

      <dialog ref={dialog} className="info-dialog" onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
        <div className="dialog-content"><button className="dialog-close icon-button" aria-label="Fechar janela" onClick={() => dialog.current?.close()}><X size={20} /></button><p className="eyebrow">{modal === 'settings' ? 'CONEXÕES' : 'SOBRE A EXPERIÊNCIA'}</p><h2>{modal === 'settings' ? 'Dê voz à conversa.' : 'Uma presença feita de possibilidades.'}</h2>
          {modal === 'settings' ? <><p className="dialog-intro">O DeepSeek cria as respostas. A OpenAI transforma o texto em voz. As chaves ficam no servidor, protegidas do navegador.</p><div className="service-list">{[{name:'DeepSeek',description:'Inteligência da conversa',active:status?.deepseek},{name:'OpenAI',description:'Voz e transcrição',active:status?.openai}].map(service => <div className="service-row" key={service.name}><div><strong>{service.name}</strong><span>{service.description}</span></div><span className={`service-state ${service.active ? 'configured' : ''}`}>{service.active ? <><Check size={13} />Configurado</> : 'Aguardando chave'}</span></div>)}</div><div className="setup-guide"><h3>Configuração local</h3><p>Preencha estas variáveis em <code>web/.env.local</code> e reinicie o aplicativo. Não coloque as chaves em mensagens ou no código público.</p><pre>DEEPSEEK_API_KEY=sua_chave{ '\n' }OPENAI_API_KEY=sua_chave</pre><p>Na versão hospedada, configure as mesmas variáveis no ambiente do servidor.</p></div><button className="primary-button" onClick={() => void refreshStatus()}><RotateCcw size={16} />Verificar conexão</button><p className="dialog-note">Sem as duas conexões, a prévia usa respostas prontas e gravações sintéticas locais. Não há consulta aos modelos nesse modo.</p></> : <><p className="dialog-intro">Gonçalves Dias ganha uma interpretação digital para uma conversa próxima, com voz, expressão e movimento.</p><div className="how-it-works"><div><span>01</span><p><strong>Você inicia a conversa.</strong>Digite uma mensagem ou use o microfone quando as conexões estiverem ativas.</p></div><div><span>02</span><p><strong>A resposta ganha voz.</strong>DeepSeek produz o texto e a OpenAI gera uma voz sintética em português.</p></div><div><span>03</span><p><strong>O personagem responde.</strong>O áudio controla a abertura da boca. Saudações como “olá” e “oi, tudo bem?” também acionam um aceno.</p></div></div><p className="dialog-note">Esta é uma representação artística com IA, não uma gravação ou uma fala histórica autêntica. A conversa fica apenas nesta sessão; mensagens e áudios enviados às APIs são processados pelos respectivos provedores.</p></>}
        </div>
      </dialog>
    </div>
  );
}