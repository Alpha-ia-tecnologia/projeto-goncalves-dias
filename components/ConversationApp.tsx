'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent, type CSSProperties } from 'react';
import { BookOpen, Check, Columns3, Focus, Footprints, Hand, Info, LoaderCircle, Maximize2, MessageSquare, Mic, Minimize2, RotateCcw, SendHorizontal, Settings2, Square, UserRound, Volume2, VolumeX, X } from 'lucide-react';
import Link from 'next/link';
import { createPortal } from 'react-dom';
import AvatarStage, { type AvatarHandle, type AvatarView, type WalkStatus } from './AvatarStage';
import WalkControls from './WalkControls';
import { SpeechPlayer, type MouthFrame } from '../lib/audio';
import { getDemoReply } from '../lib/demo';
import { VoiceActivityDetector } from '../lib/voice-activity';
import { useImmersiveMode } from './useImmersiveMode';

type Phase = 'idle' | 'thinking' | 'preparing' | 'speaking' | 'requesting' | 'recording' | 'transcribing';
type ServiceStatus = { deepseek: boolean; openai: boolean; model: string; voice: string; mode: 'live' | 'demo' };
type Message = { id: string; role: 'user' | 'assistant'; text: string; demo?: boolean };
type Gesture = 'wave' | 'nod' | 'none';
const welcome: Message = { id: 'welcome', role: 'assistant', text: 'Sou Gonçalves Dias. Trago comigo a poesia e a saudade. Diga-me: que lembrança ou ideia você gostaria de partilhar?' };
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
  const shell = useRef<HTMLDivElement>(null);
  const fullscreenEntry = useRef<HTMLButtonElement>(null);
  const microphoneButton = useRef<HTMLButtonElement>(null);
  const immersiveMode = useImmersiveMode(shell, fullscreenEntry, microphoneButton);
  const avatar = useRef<AvatarHandle>(null);
  const player = useRef<SpeechPlayer | null>(null);
  const abort = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const microphone = useRef<MediaStream | null>(null);
  const recordTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const captureCleanup = useRef<(() => void) | null>(null);
  const messageList = useRef<HTMLDivElement>(null);
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
  const [view, setView] = useState<AvatarView>('conversation');
  const [walkMode, setWalkMode] = useState(false);
  const [walkStatus, setWalkStatus] = useState<WalkStatus>({ state: 'idle', active: false, destination: null });
  const returningToChat = useRef(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const voiceEnabledRef = useRef(true);
  const [motionEnabled, setMotionEnabled] = useState(true);
  const [level, setLevel] = useState(0);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [lastSpokenId, setLastSpokenId] = useState('');
  const [modal, setModal] = useState<'settings' | 'about'>('settings');
  const [avatarVersion, setAvatarVersion] = useState(0);
  const [chatSurface, setChatSurface] = useState<HTMLDivElement | null>(null);
  const [expandedChat, setExpandedChat] = useState(false);
  const readingDialog = useRef<HTMLDialogElement>(null);
  const readingButton = useRef<HTMLButtonElement>(null);
  const inWorldChat = Boolean(chatSurface && !expandedChat && !immersiveMode.immersive);

  useEffect(() => {
    if (expandedChat && !readingDialog.current?.open) readingDialog.current?.showModal();
  }, [expandedChat]);

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
      captureCleanup.current?.();
      if (recordTimer.current) clearInterval(recordTimer.current);
      recorder.current = null;
      microphone.current = null;
      recordTimer.current = null;
      window.removeEventListener('focus', onFocus);
    };
  }, [refreshStatus]);

  useEffect(() => {
    const list = messageList.current;
    list?.scrollTo({ top: list.scrollHeight, behavior: motionEnabled ? 'smooth' : 'instant' });
  }, [messages, phase, motionEnabled, inWorldChat, expandedChat]);
  useEffect(() => {
    // Between replies the character visibly listens or thinks; speech and rest use the idle attention.
    avatar.current?.attend(phase === 'recording' ? 'listening' : phase === 'thinking' || phase === 'transcribing' || phase === 'preparing' ? 'thinking' : 'idle');
  }, [phase]);
  const onAvatarReady = useCallback(() => { setReady(true); setModelError(''); }, [setReady, setModelError]);
  const onAvatarError = useCallback((message: string) => { setModelError(message); setReady(false); }, [setReady, setModelError]);

  const onWalkStatus = useCallback((status: WalkStatus) => {
    setWalkStatus(status);
    if (status.state === 'stopped') returningToChat.current = false;
    if (status.state === 'walking' && status.destination && Math.hypot(...status.destination) > 0.01) returningToChat.current = false;
    if (status.state === 'arrived' && returningToChat.current) {
      returningToChat.current = false;
      setWalkMode(false);
      setView('conversation');
    }
  }, [setWalkStatus, setWalkMode, setView]);

  function stopWalking() {
    returningToChat.current = false;
    avatar.current?.stopWalking();
  }

  function closeWalking() {
    stopWalking();
    setWalkMode(false);
  }

  function openWalking() {
    setMotionEnabled(true);
    setWalkMode(true);
    setView('walk');
    setWalkStatus(current => current.active ? current : { state: 'idle', active: false, destination: null });
  }

  function walkToDestination(point: readonly [number, number]) {
    returningToChat.current = false;
    setMotionEnabled(true);
    setWalkMode(true);
    setView('walk');
    avatar.current?.walkTo(point);
  }

  function returnToConversation() {
    returningToChat.current = true;
    setMotionEnabled(true);
    setWalkMode(true);
    setView('walk');
    if (!avatar.current?.walkTo([0, 0])) returningToChat.current = false;
  }

  function openModal(kind: 'settings' | 'about') {
    setModal(kind);
    dialog.current?.showModal();
  }

  function stop() {
    sequence.current += 1;
    abort.current?.abort();
    abort.current = null;
    player.current?.stop();
    avatar.current?.stopGesture();
    if (recorder.current?.state === 'recording') recorder.current.stop();
    captureCleanup.current?.();
    recorder.current = null;
    microphone.current?.getTracks().forEach(track => track.stop());
    microphone.current = null;
    if (recordTimer.current) clearInterval(recordTimer.current);
    recordTimer.current = null;
    setPhase('idle');
    setLevel(0);
  }

  function enterFullscreen() {
    closeWalking();
    // This voice-only view needs spoken replies; entering never opens the microphone.
    voiceEnabledRef.current = true;
    setVoiceEnabled(true);
    immersiveMode.enter();
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
    let gestureStarted = false;
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
        : await fetch('/api/speech', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, format: 'pcm' }), signal: controller.signal });
      if (!response.ok) throw await readError(response, 'A resposta está no texto, mas não foi possível gerar a voz.');
      if (current !== sequence.current || !voiceEnabledRef.current) { await response.body?.cancel(); return; }
      const onStart = () => {
        if (current !== sequence.current || !voiceEnabledRef.current) return;
        setPhase('speaking');
        gestureStarted = true;
        if (replyGesture !== 'none') avatar.current?.gesture(replyGesture);
      };
      const activePlayer = player.current;
      if (!activePlayer) { await response.body?.cancel(); return; }
      let bytes: ArrayBuffer;
      if (!demoMode) {
        if (!response.body || !response.headers.get('Content-Type')?.startsWith('audio/pcm') || response.headers.get('X-Audio-Sample-Rate') !== '24000') {
          await response.body?.cancel();
          throw new Error('A resposta está no texto, mas o formato de voz veio incompleto. Tente novamente.');
        }
        bytes = await activePlayer.playStream(response.body, onStart);
      } else {
        bytes = await response.arrayBuffer();
        if (current !== sequence.current || !voiceEnabledRef.current) return;
        await activePlayer.play(bytes, onStart);
      }
      if (current === sequence.current) {
        lastSpeech.current = { bytes, gesture: replyGesture, messageId };
        setLastSpokenId(messageId);
        setPhase('idle');
      }
    } catch (failure) {
      if (current !== sequence.current || controller.signal.aborted) return;
      if (responseReceived && !gestureStarted && replyGesture !== 'none') avatar.current?.gesture(replyGesture);
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
    if (!status?.openai || demoMode) { stop(); openModal('settings'); return; }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { setError('Este navegador não oferece gravação de áudio. Você pode conversar por texto.'); return; }
    stop();
    setError('');
    setPhase('requesting');
    const current = ++sequence.current;
    let ownedStream: MediaStream | null = null;
    let ownedCapture: MediaRecorder | null = null;
    let ownedTimer: ReturnType<typeof setInterval> | null = null;
    let ownedContext: AudioContext | null = null;
    let ownedInput: MediaStreamAudioSourceNode | null = null;
    let ownedAnalyser: AnalyserNode | null = null;
    let noSpeech = false;
    const releaseCapture = () => {
      if (ownedTimer) clearInterval(ownedTimer);
      if (recordTimer.current === ownedTimer) recordTimer.current = null;
      ownedTimer = null;
      ownedStream?.getTracks().forEach(track => track.stop());
      if (microphone.current === ownedStream) microphone.current = null;
      if (recorder.current === ownedCapture) recorder.current = null;
      ownedInput?.disconnect();
      ownedAnalyser?.disconnect();
      ownedInput = null;
      ownedAnalyser = null;
      if (ownedContext && ownedContext.state !== 'closed') void ownedContext.close().catch(() => undefined);
      ownedContext = null;
      if (captureCleanup.current === releaseCapture) captureCleanup.current = null;
    };
    captureCleanup.current = releaseCapture;
    try {
      // Unlock the output now: automatic end-of-turn runs after user activation expires.
      if (voiceEnabledRef.current) void player.current?.unlock().catch(() => undefined);
      // Manual stop remains available if microphone analysis is unsupported.
      try {
        ownedContext = new AudioContext();
        void ownedContext.resume().catch(() => undefined);
      } catch { ownedContext = null; }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      ownedStream = stream;
      if (current !== sequence.current) { releaseCapture(); return; }
      microphone.current = stream;
      if (ownedContext) {
        ownedInput = ownedContext.createMediaStreamSource(stream);
        ownedAnalyser = ownedContext.createAnalyser();
        ownedAnalyser.fftSize = 1024;
        ownedInput.connect(ownedAnalyser);
      }
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
        if (noSpeech) { setPhase('idle'); setError('Não ouvi sua voz. Toque no microfone e tente novamente.'); return; }
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
        const activity = new VoiceActivityDetector(startedAt);
        const samples = new Float32Array(1024);
        ownedTimer = setInterval(() => {
          if (current !== sequence.current) { releaseCapture(); return; }
          const now = performance.now();
          const seconds = Math.floor((now - startedAt) / 1000);
          setRecordSeconds(Math.min(seconds, 25));
          let turnComplete = false;
          if (ownedAnalyser && ownedContext?.state === 'running') {
            ownedAnalyser.getFloatTimeDomainData(samples);
            let energy = 0;
            for (const sample of samples) energy += sample * sample;
            const rms = Math.sqrt(energy / samples.length);
            // The visitor's voice level lets the character acknowledge their pauses.
            // Once the recorder has stopped, the phase effect owns the attention;
            // a late tick before `onstop` must not turn "thinking" back into "listening".
            if (capture.state === 'recording') avatar.current?.attend('listening', Math.min(1, rms * 5));
            const detected = activity.update(rms, now);
            noSpeech = detected === 'no-speech';
            turnComplete = detected !== 'listening';
          }
          if ((seconds >= 25 || turnComplete) && capture.state === 'recording') {
            setPhase('transcribing');
            capture.stop();
          }
        }, 80);
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

  const conversationPanel = (
    <aside id="conversation-history" className="conversation-panel chat-paper" aria-label="Diálogo com Gonçalves Dias">
          <header className="conversation-panel-header"><picture className="school-mark"><source srcSet="/brand/educaprime-badge.webp" type="image/webp" /><img src="/brand/educaprime-badge.png" width={320} height={249} alt="Escola Educa Prime" /></picture><div className="conversation-title"><span>CONVERSAS COM O POETA</span><h2>Gonçalves Dias</h2></div><button className="icon-button" onClick={() => expandedChat ? readingDialog.current?.close() : setExpandedChat(true)} aria-label={expandedChat ? 'Voltar ao quadro' : 'Ampliar leitura'} title={expandedChat ? 'Voltar ao quadro' : 'Ampliar leitura'}>{expandedChat ? <Minimize2 size={20} /> : <Maximize2 size={20} />}</button><button className="icon-button" onClick={clearChat} aria-label="Limpar conversa e começar novamente" title="Nova conversa"><RotateCcw size={16} /></button></header>
          {(demoMode || statusError) && <div className="demo-notice"><p>{statusError ? 'Verifique a conexão para continuar.' : 'Respostas prontas e voz local. Conecte as APIs para conversar livremente.'}</p><button onClick={() => openModal('settings')}>Ver conexões</button></div>}
          <div ref={messageList} className="messages" tabIndex={0} role="log" aria-label="Mensagens da conversa" aria-live="polite" aria-relevant="additions text">
            <div className="conversation-date">A CONVERSA COMEÇA AQUI</div>
            {messages.map(message => <article key={message.id} className={`message message-${message.role}`}><div className="message-meta">{message.role === 'assistant' ? <>Gonçalves Dias{message.demo && <span className="demo-tag">prévia</span>}</> : 'Você'}</div><div className="message-text">{message.text}</div>{message.id === lastSpokenId && <button className="replay-button" disabled={busy || !ready || !voiceEnabled} onClick={() => void replay()}><Volume2 size={13} /> Ouvir novamente</button>}</article>)}
            {(phase === 'thinking' || phase === 'transcribing') && <div className="typing-indicator"><LoaderCircle size={14} className="spin" /><small>{phase === 'transcribing' ? 'Entendendo sua mensagem…' : 'Um instante…'}</small></div>}
          </div>
          {messages.length < 3 && <div className="suggestions" aria-label="Sugestões de conversa">{[{text:'Olá, tudo bem?',icon:Hand},{text:'Fale sobre poesia',icon:BookOpen}].map(({text,icon:Icon}) => <button key={text} disabled={busy || !status || !ready} onClick={() => void sendMessage(text)}><Icon size={14} />{text}</button>)}</div>}
          <section className="conversation-dock" aria-label="Fale com Gonçalves Dias">
            {error && <div className="error-notice" role="alert"><span>{error}</span><button aria-label="Fechar aviso" onClick={() => setError('')}><X size={16} /></button></div>}
            <div className="voice-control">
              <button ref={microphoneButton} type="button" className={`talk-button ${phase === 'recording' ? 'recording' : phase === 'speaking' ? 'speaking' : busy ? 'working' : ''}`} style={{ '--audio-level': level } as CSSProperties} disabled={!busy && (!status || !ready)} aria-describedby="voice-label" aria-label={phase === 'recording' ? 'Parar gravação e enviar' : phase === 'speaking' ? 'Interromper e falar' : busy ? 'Interromper' : demoMode ? 'Configurar voz para usar o microfone' : 'Gravar mensagem de voz'} onClick={phase === 'recording' ? finishRecording : phase === 'speaking' ? () => void startRecording() : busy ? stop : () => void startRecording()}>
                {phase === 'recording' ? <Square size={32} fill="currentColor" /> : phase === 'speaking' ? <span className="voice-bars" aria-hidden="true">{[.55,.8,1,.7,.45].map((height,index) => <i key={index} style={{ height: `${10 + level * 32 * height}px` }} />)}</span> : busy ? <LoaderCircle size={42} className="spin" /> : <Mic size={45} strokeWidth={2.3} />}
              </button>
              <span id="voice-label" role="status">{modelError ? 'Visualização indisponível' : !ready ? 'Preparando o poeta e seu gabinete…' : phase === 'idle' ? 'Clique para falar' : phase === 'recording' ? `Ouvindo · ${recordSeconds}s · uma pausa envia` : phases[phase]}</span>
            </div>
            <form onSubmit={submit} className={`composer ${phase === 'recording' ? 'recording' : ''}`}>
              <label htmlFor="message-input" className="sr-only">Sua mensagem para Gonçalves Dias</label>
              <textarea id="message-input" placeholder="Ou digite sua mensagem..." value={input} onChange={event => setInput(event.target.value)} maxLength={2000} rows={1} disabled={busy || !status || !ready} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!busy) void sendMessage(input); } }} />
              <button className="send-button" type="submit" disabled={busy || !input.trim() || !status || !ready} aria-label="Enviar mensagem"><SendHorizontal size={27} strokeWidth={1.8} /></button>
            </form>
            <div className="dock-footer"><button className="quiet-button" onClick={toggleVoice} aria-pressed={voiceEnabled}>{voiceEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}{voiceEnabled ? 'Voz ativada' : 'Só texto'}</button><span className="voice-disclosure">{demoMode ? 'Voz de demonstração' : 'Voz gerada por IA'}</span><button className="quiet-button" onClick={() => openModal('about')} aria-label="Sobre a experiência"><Info size={14} /><span>Sobre</span></button></div>
          </section>
        </aside>
  );

  return (
    <div ref={shell} className={`app-shell chat-spatial ${immersiveMode.immersive ? 'is-immersive' : ''} ${immersiveMode.controlsVisible ? 'show-immersive-controls' : ''}`} onPointerMove={immersiveMode.revealControls} onPointerDown={immersiveMode.revealControls} onKeyDown={immersiveMode.revealControls}>
      {immersiveMode.immersive && <button type="button" className="fullscreen-exit icon-button" onClick={immersiveMode.exit} aria-label="Sair da tela cheia" title="Sair da tela cheia (Esc)"><Minimize2 size={21} /></button>}
      <header className="site-header">
        <Link href="/" className="wordmark" aria-label="Acervo Vivo, início"><BookOpen className="brand-symbol" size={43} strokeWidth={2.6} /><span className="wordmark-text">Acervo Vivo</span></Link>
        <nav className="header-actions" aria-label="Navegação principal">
          <span className="current-character">Gonçalves Dias</span><span className="header-divider" aria-hidden="true" />
          <button className="profile-button" aria-label="Sobre o Acervo Vivo" title="Sobre a experiência" onClick={() => openModal('about')}><UserRound size={22} strokeWidth={2.2} /></button>
        </nav>
      </header>

      <main className="experience-stage" aria-labelledby="page-title">
        <section className="avatar-region" aria-label="Gabinete de Gonçalves Dias em 3D">
          <div className="stage-backdrop" aria-hidden="true" />
          <div className="stage-view">
            <AvatarStage key={avatarVersion} ref={avatar} view={immersiveMode.immersive && (view === 'conversation' || view === 'walk') ? 'full' : view} motionEnabled={motionEnabled} showChatPedestal={!immersiveMode.immersive} walkEnabled={walkMode && !immersiveMode.immersive} onWalkStatus={onWalkStatus} onChatSurface={setChatSurface} onReady={onAvatarReady} onError={onAvatarError} />
            {!ready && <div className="avatar-loading"><div className="loading-label" role="status">{modelError ? <><span>Não foi possível abrir a visualização 3D.</span><button className="small-button" onClick={() => { setModelError(''); setAvatarVersion(value => value + 1); }}>Tentar novamente</button></> : <><LoaderCircle size={17} className="spin" /><span>Preparando o poeta e seu gabinete…</span></>}</div></div>}
          </div>
          <div className="scene-heading"><h1 id="page-title">Gonçalves Dias</h1><p>Poeta e escritor <span className="scene-location">· Em seu gabinete</span></p></div>
          <div className="scene-actions"><button ref={readingButton} className="reading-button" onClick={() => setExpandedChat(true)}><Maximize2 size={16} />Ler conversa</button>
            <button className={`connection-pill ${!demoMode ? 'connected' : ''}`} onClick={() => openModal('settings')} title="Ver conexões"><span className="status-dot" />{statusError ? 'Sem conexão' : !status ? 'Conectando' : demoMode ? 'Demonstração' : 'Conectado'}</button>
            <button className="icon-button" aria-label="Configurar conexões" title="Configurações" onClick={() => openModal('settings')}><Settings2 size={19} /></button>
          </div>

          {walkMode && ready && !immersiveMode.immersive && <WalkControls status={walkStatus} onDestination={walkToDestination} onStop={stopWalking} onReturn={returnToConversation} onClose={closeWalking} />}
          <div className="scene-tools" aria-label="Controles do personagem">
            <button ref={fullscreenEntry} type="button" className="icon-button fullscreen-toggle" disabled={!ready} aria-label="Tela cheia: somente o avatar e o microfone" title="Tela cheia" onClick={enterFullscreen}><Maximize2 size={18} /></button>
            <button className="icon-button" disabled={!ready} aria-label="Conversar no quadro" title="Conversar no quadro" aria-pressed={view === 'conversation'} onClick={returnToConversation}><MessageSquare size={18} /></button>
            <button className="icon-button" aria-label="Ver gabinete" title="Ver gabinete" aria-pressed={view === 'room'} onClick={() => { closeWalking(); setView('room'); }}><Columns3 size={18} /></button>
            <button className="icon-button" aria-label={view === 'portrait' ? 'Ver corpo inteiro' : 'Aproximar personagem'} title={view === 'portrait' ? 'Ver corpo inteiro' : 'Aproximar personagem'} onClick={() => { closeWalking(); setView(value => value === 'portrait' ? 'full' : 'portrait'); }}><Focus size={18} /></button>
            <button className="icon-button" aria-label="Restaurar enquadramento" title="Restaurar enquadramento" onClick={() => avatar.current?.resetView()}><RotateCcw size={17} /></button>
            <button className={`icon-button ${!motionEnabled ? 'muted-control' : ''}`} aria-label={motionEnabled ? 'Desativar gestos automáticos' : 'Ativar gestos automáticos'} title={motionEnabled ? 'Gestos automáticos ativados' : 'Gestos pausados. Clique para ativar.'} aria-pressed={motionEnabled} onClick={() => setMotionEnabled(value => !value)}><Hand size={18} /></button>
            <button className="walk-toggle" type="button" disabled={!ready} aria-expanded={walkMode} onClick={walkMode ? closeWalking : openWalking}><Footprints size={17} />Caminhar</button>
            <span className="scene-hint">{motionEnabled ? 'Arraste para explorar' : 'Gestos automáticos pausados'}</span>
          </div>

        </section>

        {inWorldChat && chatSurface ? createPortal(conversationPanel, chatSurface) : !expandedChat && immersiveMode.immersive ? conversationPanel : null}
      </main>

      <dialog ref={readingDialog} className="reading-dialog" aria-label="Conversa ampliada" onClose={() => { setExpandedChat(false); requestAnimationFrame(() => readingButton.current?.focus({ preventScroll: true })); }} onClick={event => { if (event.target === event.currentTarget) readingDialog.current?.close(); }}>
        {expandedChat && conversationPanel}
      </dialog>
      <dialog ref={dialog} className="info-dialog" aria-labelledby="info-dialog-title" onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
        <div className="dialog-content"><button className="dialog-close icon-button" aria-label="Fechar janela" onClick={() => dialog.current?.close()}><X size={20} /></button><p className="eyebrow">{modal === 'settings' ? 'CONEXÕES' : 'SOBRE A EXPERIÊNCIA'}</p><h2 id="info-dialog-title">{modal === 'settings' ? 'Dê voz à conversa.' : 'Uma presença feita de possibilidades.'}</h2>
          {modal === 'settings' ? <><p className="dialog-intro">O agente com DeepSeek pode consultar o acervo disponível para preparar as respostas. A OpenAI transforma o texto em voz. As chaves ficam no servidor, protegidas do navegador.</p><div className="service-list">{[{name:'DeepSeek',description:'Inteligência da conversa',active:status?.deepseek},{name:'OpenAI',description:'Voz e transcrição',active:status?.openai}].map(service => <div className="service-row" key={service.name}><div><strong>{service.name}</strong><span>{service.description}</span></div><span className={`service-state ${service.active ? 'configured' : ''}`}>{service.active ? <><Check size={13} />Configurado</> : 'Aguardando chave'}</span></div>)}</div><div className="setup-guide"><h3>Configuração local</h3><p>Preencha estas variáveis em <code>web/.env.local</code> e reinicie o aplicativo. Não coloque as chaves em mensagens ou no código público.</p><pre>DEEPSEEK_API_KEY=sua_chave{ '\n' }OPENAI_API_KEY=sua_chave</pre><p>Neste projeto, as conexões com as APIs ficam na execução local. A versão hospedada funciona como demonstração.</p></div><button className="primary-button" onClick={() => void refreshStatus()}><RotateCcw size={16} />Verificar conexão</button><p className="dialog-note">Sem as duas conexões, a prévia usa respostas prontas e gravações sintéticas locais. Não há consulta aos modelos nesse modo.</p></> : <><p className="dialog-intro">Gonçalves Dias ganha uma interpretação digital para uma conversa próxima, com voz, expressão e movimento.</p><div className="how-it-works"><div><span>01</span><p><strong>Você inicia a conversa.</strong>Digite ou toque no microfone. Uma pausa ao terminar envia sua fala; você também pode tocar novamente para enviar.</p></div><div><span>02</span><p><strong>Minha resposta ganha voz.</strong>Quando conectado, o agente pode consultar meu acervo para preparar a resposta. A OpenAI gera uma voz masculina em português brasileiro, com entonação e pausas naturais.</p></div><div><span>03</span><p><strong>O personagem responde.</strong>A boca acompanha o áudio, enquanto cabeça, pescoço e mãos acompanham o ritmo da conversa. Enquanto ouve você, ele inclina a cabeça e acena nas suas pausas; enquanto prepara a resposta, desvia o olhar. Saudações como “olá” e “oi, tudo bem?” também acionam um aceno.</p></div></div><p className="dialog-note">Esta é uma representação artística com IA, não uma gravação ou uma fala histórica autêntica. A conversa fica apenas nesta sessão; mensagens e áudios enviados às APIs são processados pelos respectivos provedores.</p></>}
        </div>
      </dialog>
    </div>
  );
}