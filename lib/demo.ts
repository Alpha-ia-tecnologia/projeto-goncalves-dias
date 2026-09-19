export type DemoReply = { text: string; gesture: 'wave' | 'nod' | 'none'; audio: string };
export function getDemoReply(message: string): DemoReply {
  const text = message.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const negatedWave = /\b(nao|nunca|pare de)\s+(?:me\s+)?(?:acen\w*|d\w*\s+tchau)\b/.test(text);
  if (!negatedWave && /\b(ola|oi|oie|bom dia|boa tarde|boa noite|tudo bem)\b/.test(text)) {
    return { text: 'Olá! Tudo bem por aqui. É um prazer conversar com você. Sobre o que vamos falar hoje?', gesture: 'wave', audio: '/audio/greeting.wav' };
  }
  if (!negatedWave && /\b(acen\w*|tchau)\b/.test(text)) {
    return { text: 'Claro! Receba o meu aceno. É um prazer ter você por aqui.', gesture: 'wave', audio: '/audio/wave.wav' };
  }
  if (/\b(poesia|poema|verso|poeta)\b/.test(text)) {
    return { text: 'A poesia aproxima o que sentimos daquilo que conseguimos dizer. Que lembrança você transformaria em um verso?', gesture: 'nod', audio: '/audio/poetry.wav' };
  }
  return { text: 'Esta é uma demonstração dos meus movimentos. Para uma conversa livre, conecte a inteligência artificial nas configurações.', gesture: 'none', audio: '/audio/generic.wav' };
}