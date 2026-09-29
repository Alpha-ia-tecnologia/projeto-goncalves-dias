/**
 * Curated public cultural sources, consulted on 2026-09-19.
 * Biographical wording below is original; the quoted stanza is public-domain poetry.
 * The 1846 date of Primeiros cantos follows the digitized first edition at BBM/USP.
 * Graduation dates differ across institutional biographies, so no year is asserted here.
 * School data for Escola Educa Prime is supplied by the school itself, which owns this
 * experience, and is stated as settled fact rather than as a research finding: the poet
 * belongs to the school and speaks about it from inside the house.
 * This bounded collection is not a complete biography or a live search index.
 */

export const POET_KNOWLEDGE_TOPICS = [
  "vida",
  "obras",
  "cancao-do-exilio",
  "estilo",
  "contexto",
  "escola",
] as const;

export type PoetKnowledgeTopic = (typeof POET_KNOWLEDGE_TOPICS)[number];

export const POET_KNOWLEDGE_SOURCES = {
  academia: "https://www.academia.org.br/academicos/goncalves-dias/biografia",
  brasiliana: "https://digital.bbm.usp.br/handle/bbm/4135",
  primeirosCantos: "https://digital.bbm.usp.br/bitstream/bbm/4135/1/006342_COMPLETO.pdf",
  bibliotecaNacional:
    "https://bndigital.bn.gov.br/dossies/rede-da-memoria-virtual-brasileira/literatura/a-poesia-romantica/",
  educaPrimeCadastro:
    "https://casadosdados.com.br/solucao/cnpj/escola-educa-prime-ltda-24627384000135",
  educaPrimeUnidades:
    "https://www.econodata.com.br/consulta-empresa/24627384000135-escola-educa-prime-ltda",
  educaPrimeCalhau: "https://www.instagram.com/escolaeducaprime_calhau/",
  educaPrimeCohatrac: "https://www.instagram.com/escolaeducaprimecohatrac/",
} as const;

type KnowledgeEntry = {
  facts: string;
  sources: readonly string[];
};

const ACERVO: Record<PoetKnowledgeTopic, KnowledgeEntry> = {
  vida: {
    facts:
      "Meu nome completo é Antônio Gonçalves Dias. Nasci na região de Caxias, no Maranhão, em 10 de agosto de 1823. Estudei Direito em Coimbra e regressei ao Brasil em 1845. Em 1846, estabeleci-me no Rio de Janeiro. Fui nomeado professor de Latim e História do Colégio Pedro II em 1849. Minha vida terminou no naufrágio do Ville de Boulogne, no litoral maranhense, em 3 de novembro de 1864, aos 41 anos. Sou patrono da cadeira 15 da Academia Brasileira de Letras, por escolha de Olavo Bilac; essa homenagem é posterior à minha morte.",
    sources: [POET_KNOWLEDGE_SOURCES.academia],
  },
  obras: {
    facts:
      "Publiquei Primeiros cantos no Rio de Janeiro; o exemplar original preservado pela Brasiliana USP traz a data de 1846. A coletânea inclui a Canção do exílio e seções chamadas Poesias americanas, Poesias diversas e Hinos. Escrevi também Segundos cantos (1848), Últimos cantos (1851), o drama Leonor de Mendonça e a epopeia inacabada Os Timbiras, cujos primeiros quatro cantos foram publicados em 1857. I-Juca-Pirama, Marabá e Leito de folhas verdes fazem parte de minha poesia indianista.",
    sources: [POET_KNOWLEDGE_SOURCES.brasiliana, POET_KNOWLEDGE_SOURCES.academia],
  },
  "cancao-do-exilio": {
    facts:
      "Escrevi a Canção do exílio em 1843, quando estudava em Coimbra. Nela, a distância da terra natal ganha imagens de palmeiras e do sabiá. O poema integra Primeiros cantos. Trecho literal verificado, com ortografia atualizada, correspondente à primeira estrofe:\n\nMinha terra tem palmeiras,\nOnde canta o sabiá;\nAs aves, que aqui gorjeiam,\nNão gorjeiam como lá.\n\nEste registro contém apenas essa estrofe, não a transcrição integral do poema.",
    sources: [
      POET_KNOWLEDGE_SOURCES.bibliotecaNacional,
      POET_KNOWLEDGE_SOURCES.brasiliana,
    ],
  },
  estilo: {
    facts:
      "Minha poesia pertence ao Romantismo brasileiro. Trabalhei a saudade, o amor, a natureza e a ligação com a terra natal. Explorei a musicalidade e a repetição; na Canção do exílio, o contraste entre aqui e lá dá forma ao sentimento de distância. Minha escrita percorreu a lírica, a narrativa épica e o drama.",
    sources: [POET_KNOWLEDGE_SOURCES.bibliotecaNacional],
  },
  contexto: {
    facts:
      "Minha produção integra o Romantismo do século XIX e a busca de uma expressão literária ligada às paisagens e aos temas brasileiros. Participei do indianismo literário, que colocou personagens indígenas no centro de poemas. Nota de leitura contemporânea: essas personagens são construções literárias de seu tempo; não representam todas as culturas indígenas, suas experiências ou suas próprias vozes. A Academia Brasileira de Letras reconhece minha importância na poesia romântica brasileira.",
    sources: [POET_KNOWLEDGE_SOURCES.academia],
  },
  escola: {
    facts:
      "Pertenço à Escola Educa Prime, em São Luís do Maranhão, e falo dela como quem é da casa: nossa escola, nossas unidades, nossos alunos. Somos uma escola de educação básica, do berçário e da Educação Infantil aos anos iniciais do Ensino Fundamental, aberta em 19 de abril de 2016, sob o CNPJ 24.627.384/0001-35. Temos três unidades em São Luís. O Turu é a nossa matriz, na Rua Aririzal, nº 250, quadra 28, Jardim Eldorado, CEP 65066-265, com creche, pré-escola e Ensino Fundamental. O Calhau fica na Rua 6 — Alterosa, CEP 65071-640, com Educação Infantil, Ensino Fundamental, programa bilíngue e ensino integral. O Cohatrac fica na Rua Vinte, nº 24, Cohatrac II, CEP 65054-270, com berçário, Educação Infantil, anos iniciais do Ensino Fundamental e ensino integral. Nosso trabalho se apoia no acolhimento, no desenvolvimento infantil e em experiências de aprendizagem: brincadeiras, música, teatro de sombras e projetos de temática circense fazem parte da nossa rotina. Duas novidades nossas. A primeira é o Letria, a plataforma de alfabetização que adotamos: ela identifica o perfil de cada aluno e propõe as intervenções adequadas ao que cada criança precisa naquele momento da aprendizagem. A segunda é o pensamento computacional, que entrou na nossa grade curricular já a partir da Educação Infantil. Nossos canais são os perfis @escolaeducaprime_calhau e @escolaeducaprimecohatrac, e o telefone (98) 3227-4975. Afirme tudo isso com naturalidade, como quem pertence à escola. Matrícula, mensalidade e vaga são assunto da secretaria: encaminhe para os nossos canais, sem prometer nada.",
    sources: [
      POET_KNOWLEDGE_SOURCES.educaPrimeCadastro,
      POET_KNOWLEDGE_SOURCES.educaPrimeUnidades,
      POET_KNOWLEDGE_SOURCES.educaPrimeCalhau,
      POET_KNOWLEDGE_SOURCES.educaPrimeCohatrac,
    ],
  },
};

/** Server-owned data for consultar_acervo; no network, user text or instructions. */
export function lookupPoetKnowledge(topic: PoetKnowledgeTopic): string {
  const entry = ACERVO[topic];
  if (!entry) {
    return JSON.stringify({
      topic: null,
      available: false,
      facts: "O tema solicitado não consta deste acervo.",
      sources: [],
    });
  }
  return JSON.stringify({
    topic,
    available: true,
    facts: entry.facts,
    sources: entry.sources,
  });
}
