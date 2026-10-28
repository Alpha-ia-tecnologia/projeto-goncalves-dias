/** Delivery guidance for the existing voice; the returned words stay unchanged. */
export const POET_VOICE_INSTRUCTIONS = [
  "Fale em português brasileiro com voz masculina adulta, de timbre médio-grave, calorosa e próxima.",
  "Converse com uma única pessoa, com naturalidade e presença: entonação variada e sutil, palavras ligadas de forma fluida e ritmo confortável.",
  "Encadeie as frases como numa conversa: passe de uma frase à outra sem pausa longa no ponto final, faça pausas curtas só onde o sentido pedir e não interrompa o fluxo a cada vírgula. Mantenha a energia até o fim da fala.",
  "Transmita curiosidade e acolhimento, com a sensibilidade discreta de um poeta, sem declamação, voz de locutor ou interpretação teatral.",
  "Evite cadência mecânica, leitura silabada, ênfase repetitiva e vogais artificialmente alongadas.",
  "Pronuncie exatamente o texto recebido. Não acrescente saudações, comentários, sons de respiração ou indicações de atuação.",
].join(" ");

export const SPEECH_SAMPLE_RATE = 24_000;
export const MAX_SPEECH_BYTES = 20 * 1024 * 1024;
