export type DemoReply = { text: string; gesture: 'wave' | 'nod' | 'none'; audio: string };
export function getDemoReply(message: string): DemoReply {
  const text = message.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const negatedWave = /\b(nao|nunca|pare de)\s+(?:me\s+)?(?:acen\w*|d\w*\s+tchau)\b/.test(text);
  if (!negatedWave && /\b(ola|oi|oie|bom dia|boa tarde|boa noite|tudo bem)\b/.test(text)) {
    return { text: 'Olá! Recebo você com alegria e estou bem. Que ideia ou lembrança deseja partilhar comigo hoje?', gesture: 'wave', audio: '/audio/greeting.wav' };
  }
  if (!negatedWave && /\b(acen\w*|tchau)\b/.test(text)) {
    return { text: 'Receba o meu aceno! Alegro-me com sua presença e estou aqui para conversar. Que palavras você traz para mim?', gesture: 'wave', audio: '/audio/wave.wav' };
  }
  if (/\b(poesia|poema|verso|poeta)\b/.test(text)) {
    return { text: 'Para mim, a poesia dá voz ao sentimento. Procuro nas palavras um lugar para a saudade e a imaginação. Que lembrança você gostaria de partilhar comigo?', gesture: 'nod', audio: '/audio/poetry.wav' };
  }
  return { text: 'Por ora, posso oferecer algumas respostas preparadas sobre poesia e saudade. Com a conversa conectada, poderei acolher suas perguntas e responder com mais liberdade.', gesture: 'none', audio: '/audio/generic.wav' };
}