import { describe, expect, it, vi } from 'vitest';
import { SpeechPlaybackError, type SpeechPlayer } from '../lib/audio';
import { playSpeechResponse } from '../lib/speech-transport';

const text = 'A resposta que já aparece na conversa.';
const wavBytes = new Uint8Array([82, 73, 70, 70]).buffer;
const pcmResponse = () => new Response(new Uint8Array([0, 0]), {
  headers: { 'Content-Type': 'audio/pcm', 'X-Audio-Sample-Rate': '24000' },
});
const wavResponse = () => new Response(wavBytes.slice(0), { headers: { 'Content-Type': 'audio/wav' } });
function setup() {
  const controller = new AbortController();
  const player = {
    playStream: vi.fn<SpeechPlayer['playStream']>().mockResolvedValue(wavBytes),
    play: vi.fn<SpeechPlayer['play']>().mockResolvedValue(undefined),
    stop: vi.fn(),
  };
  const fetcher = vi.fn<typeof fetch>();
  const onStart = vi.fn();
  return { controller, player, fetcher, onStart,
    options: { text, signal: controller.signal, player, fetcher, onStart } };
}
const beforeAudio = () => new SpeechPlaybackError('Transmissão interrompida', { canRetryBuffered: true });

describe('recuperação do transporte de voz', () => {
  it('mantém o caminho PCM sem outro pedido quando a transmissão funciona', async () => {
    const { options, fetcher, player } = setup();
    fetcher.mockResolvedValueOnce(pcmResponse());
    expect(await playSpeechResponse(options)).toBe(wavBytes);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(player.playStream).toHaveBeenCalledOnce();
    expect(player.play).not.toHaveBeenCalled();
  });

  it.each(['fetch', 'stream'])('recupera uma falha de %s antes do áudio usando um único WAV do mesmo texto', async failureAt => {
    const { options, fetcher, player, onStart } = setup();
    if (failureAt === 'fetch') fetcher.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    else { fetcher.mockResolvedValueOnce(pcmResponse()); player.playStream.mockRejectedValueOnce(beforeAudio()); }
    fetcher.mockResolvedValueOnce(wavResponse());
    player.play.mockImplementationOnce(async (_bytes, started) => { started?.(); });
    expect(await playSpeechResponse(options)).toEqual(wavBytes);
    expect(fetcher.mock.calls.map(([url, init]) => ({ url, ...JSON.parse(init!.body as string) }))).toEqual([
      { url: '/api/speech', text, format: 'pcm' }, { url: '/api/speech', text, format: 'wav' },
    ]);
    expect(player.play).toHaveBeenCalledOnce();
    expect(onStart).toHaveBeenCalledOnce();
  });

  it('não reinicia uma fala que já teve algum bloco agendado', async () => {
    const { options, fetcher, player, onStart } = setup();
    fetcher.mockResolvedValueOnce(pcmResponse());
    player.playStream.mockRejectedValueOnce(new SpeechPlaybackError('Áudio interrompido', { canRetryBuffered: false }));
    await expect(playSpeechResponse(options)).rejects.toThrow('Áudio interrompido');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(player.play).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled(); // No RAF notification is needed to forbid replay.
  });

  it.each([401, 429, 502, 503, 504])('não repete erro HTTP %i do servidor/provedor', async status => {
    const { options, fetcher, player } = setup();
    fetcher.mockResolvedValueOnce(Response.json({ error: { message: 'Serviço de voz indisponível.' } }, { status }));
    await expect(playSpeechResponse(options)).rejects.toThrow('Serviço de voz indisponível.');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(player.play).not.toHaveBeenCalled();
    expect(player.playStream).not.toHaveBeenCalled();
  });

  it('não tenta outro formato para resposta PCM inválida ou falha local do player', async () => {
    const invalid = setup();
    invalid.fetcher.mockResolvedValueOnce(wavResponse());
    await expect(playSpeechResponse(invalid.options)).rejects.toThrow('formato de voz');
    expect(invalid.fetcher).toHaveBeenCalledOnce();
    const local = setup();
    local.fetcher.mockResolvedValueOnce(pcmResponse());
    local.player.playStream.mockRejectedValueOnce(new SpeechPlaybackError('O navegador bloqueou o áudio.'));
    await expect(playSpeechResponse(local.options)).rejects.toThrow('navegador bloqueou');
    expect(local.fetcher).toHaveBeenCalledOnce();
  });

  it.each(['fetch', 'body'])('encerra a falha de WAV em %s sem um terceiro pedido', async failureAt => {
    const { options, fetcher, player } = setup();
    fetcher.mockRejectedValueOnce(new TypeError('HTTP2 protocol error'));
    if (failureAt === 'fetch') fetcher.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    else fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) {
      controller.error(new TypeError('terminated'));
    } }), { headers: { 'Content-Type': 'audio/wav' } }));
    await expect(playSpeechResponse(options)).rejects.toThrow('A resposta está no texto, mas a conexão da voz falhou.');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(player.play).not.toHaveBeenCalled();
  });

  it('cancela o fallback pendente e não toca uma resposta que chegou depois', async () => {
    const { options, fetcher, player, controller } = setup();
    let resolveWav!: (response: Response) => void;
    const cancel = vi.fn();
    fetcher.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    fetcher.mockImplementationOnce(() => new Promise(resolve => { resolveWav = resolve; }));
    const result = playSpeechResponse(options).catch(error => error);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    controller.abort();
    resolveWav(new Response(new ReadableStream({ cancel }), { headers: { 'Content-Type': 'audio/wav' } }));
    expect(await result).toMatchObject({ name: 'AbortError' });
    expect(player.stop).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(player.play).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('não dispara fallback se outra resposta substituiu a solicitação', async () => {
    const { options, fetcher, player } = setup();
    let current = true;
    fetcher.mockResolvedValueOnce(pcmResponse());
    player.playStream.mockImplementationOnce(async () => { current = false; throw beforeAudio(); });
    await expect(playSpeechResponse({ ...options, isCurrent: () => current })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(player.play).not.toHaveBeenCalled();
  });

  it('não recupera cancelamento de usuário nem deixa listener antigo parar um replay futuro', async () => {
    const cancelled = setup();
    cancelled.fetcher.mockRejectedValueOnce(new DOMException('cancelled', 'AbortError'));
    await expect(playSpeechResponse(cancelled.options)).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled.fetcher).toHaveBeenCalledOnce();
    const completed = setup();
    completed.fetcher.mockResolvedValueOnce(pcmResponse());
    await playSpeechResponse(completed.options);
    completed.controller.abort();
    expect(completed.player.stop).not.toHaveBeenCalled();
  });
});
