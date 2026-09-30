import { SpeechPlaybackError, type SpeechPlayer } from './audio';

const FETCH_ERROR = 'A resposta está no texto, mas a conexão da voz falhou. Verifique sua conexão e tente novamente.';
const FORMAT_ERROR = 'A resposta está no texto, mas o formato de voz veio incompleto. Tente novamente.';
const abortError = () => new DOMException('Reprodução cancelada', 'AbortError');
const isAbort = (error: unknown) => error instanceof Error && error.name === 'AbortError';
const isNetworkFailure = (error: unknown) => error instanceof TypeError
  || (error instanceof DOMException && error.name === 'NetworkError');

type SpeechTransportOptions = {
  text: string;
  signal: AbortSignal;
  player: Pick<SpeechPlayer, 'playStream' | 'play' | 'stop'>;
  onStart?: () => void;
  isCurrent?: () => boolean;
  fetcher?: typeof fetch;
};

async function responseError(response: Response): Promise<Error> {
  let message = 'A resposta está no texto, mas não foi possível gerar a voz.';
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object' && 'error' in body && body.error && typeof body.error === 'object'
      && 'message' in body.error && typeof body.error.message === 'string') message = body.error.message;
  } catch { /* HTTP failures keep their status meaning even when the body is incomplete. */ }
  return new Error(message);
}

/** Retry transport once as complete WAV, only before PCM could have been heard. */
export async function playSpeechResponse(options: SpeechTransportOptions): Promise<ArrayBuffer> {
  const { text, signal, player, onStart, isCurrent, fetcher = fetch } = options;
  const assertActive = () => { if (signal.aborted || isCurrent?.() === false) throw abortError(); };
  const assertResponseActive = (response: Response) => {
    try { assertActive(); } catch (error) {
      void response.body?.cancel().catch(() => undefined);
      throw error;
    }
  };
  const cancelPlayback = () => player.stop();
  const started = () => { if (!signal.aborted && isCurrent?.() !== false) onStart?.(); };
  const request = async (format: 'pcm' | 'wav') => {
    assertActive();
    let response: Response;
    try {
      response = await fetcher('/api/speech', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, format }), signal,
      });
    } catch (error) {
      assertActive();
      if (isAbort(error)) throw abortError();
      throw new SpeechPlaybackError(FETCH_ERROR, { cause: error, canRetryBuffered: format === 'pcm' && isNetworkFailure(error) });
    }
    assertResponseActive(response);
    if (!response.ok) throw await responseError(response);
    return response;
  };
  assertActive();
  signal.addEventListener('abort', cancelPlayback, { once: true });
  try {
    try {
      const response = await request('pcm');
      assertResponseActive(response);
      if (!response.body || !response.headers.get('Content-Type')?.startsWith('audio/pcm')
        || response.headers.get('X-Audio-Sample-Rate') !== '24000') {
        void response.body?.cancel().catch(() => undefined);
        throw new Error(FORMAT_ERROR);
      }
      const bytes = await player.playStream(response.body, started);
      assertActive();
      return bytes;
    } catch (error) {
      assertActive();
      if (!(error instanceof SpeechPlaybackError) || !error.canRetryBuffered) throw error;
    }

    // This branch is intentionally not inside the retry catch: no third request.
    const response = await request('wav');
    assertResponseActive(response);
    if (!response.headers.get('Content-Type')?.startsWith('audio/wav')) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error(FORMAT_ERROR);
    }
    let bytes: ArrayBuffer;
    try { bytes = await response.arrayBuffer(); } catch (error) {
      assertActive();
      if (isAbort(error)) throw abortError();
      throw new SpeechPlaybackError(FETCH_ERROR, { cause: error });
    }
    assertActive();
    await player.play(bytes, started);
    assertActive();
    return bytes;
  } finally {
    signal.removeEventListener('abort', cancelPlayback);
  }
}
