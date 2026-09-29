/** Delivery guidance for the existing voice; the returned words stay unchanged. */
export const POET_VOICE_INSTRUCTIONS = [
  "Fale em português brasileiro com voz masculina adulta, de timbre médio-grave, calorosa e próxima.",
  "Converse com uma única pessoa, com naturalidade e presença: entonação variada e sutil, palavras ligadas de forma fluida e ritmo confortável.",
  "Faça pausas curtas onde o sentido pedir; respeite a pontuação sem interromper o fluxo a cada vírgula. Termine as frases suavemente.",
  "Transmita curiosidade e acolhimento, com a sensibilidade discreta de um poeta, sem declamação, voz de locutor ou interpretação teatral.",
  "Evite cadência mecânica, leitura silabada, ênfase repetitiva e vogais artificialmente alongadas.",
  "Pronuncie exatamente o texto recebido. Não acrescente saudações, comentários, sons de respiração ou indicações de atuação.",
].join(" ");

export const SPEECH_SAMPLE_RATE = 24_000;
export const MAX_SPEECH_BYTES = 20 * 1024 * 1024;
