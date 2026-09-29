# Acervo Vivo — Gonçalves Dias

Aplicação web com o modelo 3D do projeto Blender, conversa em português com um agente LangChain usando DeepSeek, voz sintetizada pela OpenAI, movimento de boca durante o áudio e aceno ao ouvir cumprimentos como “olá” ou “oi, tudo bem?”. O personagem é uma representação artística, com voz gerada por IA.

## Executar no Windows

Requer Node.js 22.13 ou superior. No PowerShell:

```powershell
cd D:\projetos-dev1\render-goncalves-dias\web
npm install
if (-not (Test-Path .env.local)) { Copy-Item .env.example .env.local }
notepad .env.local
npm run dev
```

Abra o endereço exibido pelo terminal, normalmente `http://localhost:3000`. Microfone funciona em `localhost` ou em HTTPS e pede permissão ao navegador.

Preencha apenas no arquivo local:

```dotenv
DEEPSEEK_API_KEY=sua_chave_deepseek
OPENAI_API_KEY=sua_chave_openai
DEEPSEEK_MODEL=deepseek-flash
OPENAI_TTS_MODEL=gpt-4o-mini-tts
OPENAI_TTS_VOICE=cedar
```

Reinicie o servidor após editar as variáveis. `.env.local` é ignorado pelo Git. Não use prefixos `VITE_` ou `NEXT_PUBLIC_` nas chaves. A aplicação lê os segredos exclusivamente nas rotas do servidor, pelo binding `env` do Cloudflare Worker. Não há campo para chaves na página.

Sem as duas chaves, a interface oferece uma demonstração identificada, com respostas preparadas e áudio local. Ela não representa uma conexão ativa com DeepSeek ou GPT. As rotas reais retornam `503 CONFIG_REQUIRED` quando a chave necessária está ausente. Falhas de serviço não são substituídas silenciosamente por respostas de demonstração. `/api/status` indica presença de configuração; uma chave presente ainda pode estar inválida ou sem saldo.

## Conversa, voz e animação

O diálogo, o microfone e o campo de mensagem ficam em uma coluna permanente à direita do avatar. Em telas de até 840 px, o painel fica abaixo do palco, sem sobrepor o personagem. A rolagem automática fica restrita às mensagens, preservando a posição da página.

O botão **Tela cheia** nos controles do personagem abre uma apresentação com apenas o avatar e o microfone. O mesmo modelo, áudio e histórico continuam ativos; nenhum deles é reiniciado ao trocar de modo. Mover o ponteiro ou tocar na tela revela a saída no canto superior direito por alguns segundos. **Esc** também retorna à conversa. Navegadores sem suporte à tela cheia nativa usam o mesmo modo dentro da janela. A entrada habilita respostas faladas, mas o microfone só é aberto após tocar no botão e conceder a permissão do navegador.

1. Uma mensagem digitada segue para `/api/chat`; uma gravação passa primeiro por `/api/transcribe`.
2. O servidor executa um agente LangChain com DeepSeek, histórico limitado e a ferramenta consultar_acervo. O agente consulta fatos selecionados sobre vida, obras, poesia e a escola EDUCAPRIME, e entrega uma fala em primeira pessoa e um gesto validados.
3. O texto da resposta segue para `/api/speech`, que usa `gpt-4o-mini-tts` e a voz Cedar com direção masculina em português brasileiro: timbre médio-grave, entonação variada, ritmo conversacional e pausas breves, sem declamação. Não há alteração artificial de pitch ou velocidade.
4. O áudio PCM mono de 24 kHz chega progressivamente. O navegador começa com 160 ms de áudio disponíveis e agenda blocos contíguos, sem esperar o arquivo completo. Um analisador do áudio efetivamente reproduzido controla os três morphs da boca; cabeça, pescoço e torso acompanham a intensidade, enquanto as duas mãos alternam gestos moderados de conversa. O aceno tem prioridade sobre o gesto da mão direita; pausas e interrupções relaxam os braços suavemente. As transições são suavizadas e a boca fecha nas pausas. É sincronização por energia e espectro, não reconhecimento fonético de visemas.
5. “Olá”, “oi”, “bom dia” e pedidos de aceno disparam o gesto `wave`. A regra considera palavras completas, aceita acentos e respeita “não acene”.

Ao usar o microfone, uma pausa de aproximadamente 1,4 segundo após a fala envia a mensagem automaticamente. Um ruído muito breve não dispara o envio; oito segundos sem fala encerram a captura sem enviar, e toda gravação termina em até 25 segundos. O botão também permite enviar manualmente. Durante a resposta, tocar no microfone interrompe a voz e inicia uma nova gravação; o braço retorna suavemente ao repouso. A captura nunca reabre sozinha.

O fluxo de áudio cancela a leitura e os blocos agendados ao interromper. “Ouvir novamente” fica disponível após a reprodução completa e usa o WAV mantido apenas na memória da sessão. A geração e a reprodução continuam sujeitas à conexão e ao dispositivo; não há promessa de latência fixa.

Os controles de demonstração permitem conferir o modelo, a boca e os gestos antes de configurar os serviços. A síntese real usa a voz `cedar` por padrão; o modelo e a voz são configuráveis. O aplicativo não tenta reproduzir a voz histórica de Gonçalves Dias.

## O agente Gonçalves Dias

O servidor usa `createAgent` do LangChain e `ChatDeepSeek`. A personagem fala em primeira pessoa: “Nasci…”, “Escrevi…” e “Minha poesia…”. O aviso de interpretação artística permanece na interface; em perguntas explícitas sobre autenticidade, o poeta também explica sua natureza digital em primeira pessoa.

O poeta pertence à escola EDUCAPRIME e menciona a escola sempre que se apresenta — ao se identificar, ao responder “quem é você?” ou ao explicar o que faz aqui. Fora da apresentação, a menção não se repete a cada resposta.

Ele fala da escola como quem é da casa: “nossa escola”, “aqui na Educa Prime”, “nossos alunos”. As instruções proíbem o tom de pesquisa — nada de “segundo os registros”, “consta que”, “ao que parece” ou “seria preciso confirmar” — e também a citação de fontes e cadastros no tema `escola`, que fica reservada aos temas de vida e obra. Os dados de unidades, endereços, segmentos, atividades, novidades e contatos vêm do tema `escola` do acervo (São Luís — MA; unidades Turu, Calhau e Cohatrac; CNPJ 24.627.384/0001-35) e são afirmados, não relativizados.

O acervo guarda duas novidades da escola: o **Letria**, plataforma de alfabetização adotada para identificar o perfil de cada aluno e propor as intervenções adequadas, e a entrada do **pensamento computacional** na grade curricular já a partir da Educação Infantil.

Os limites permanecem: o poeta não inventa mensalidades, vagas, número de alunos, professores, prêmios ou promessas de matrícula, não assume compromissos em nome da escola e encaminha matrícula, valores e vaga aos canais da escola. O que o acervo não cobre é respondido de dentro da casa — “isso é melhor confirmar com a nossa secretaria” — e não como lacuna de pesquisa.

A ferramenta `consultar_acervo` consulta seis temas locais: vida, obras, Canção do exílio, estilo, contexto e escola. O acervo cita a Academia Brasileira de Letras, a Biblioteca Nacional e a Brasiliana USP. O tema escola é fornecido pela própria Escola Educa Prime e, por isso, é afirmado na conversa sem citação de fonte. Ele é pequeno e curado, sem pesquisa aberta na internet: detalhes não cobertos devem receber uma admissão de incerteza. Apenas a primeira estrofe verificada de Canção do exílio está disponível para recitação.

A saída estruturada `resposta_do_poeta` contém `text` e `gesture`. Antes de liberar uma fala, o servidor valida tamanho, gesto e marcas linguísticas de primeira pessoa. Respostas que falham voltam ao agente para correção. A execução permite até quatro chamadas ao modelo e três consultas a ferramentas, com prazo único de 45 segundos e cancelamento pelo usuário. Esses limites incluem tentativas de correção; não há repetição ilimitada nem resposta simulada no lugar de uma falha real.

O histórico da sessão é enviado em cada pedido. O agente é criado por solicitação e não compartilha memória persistente entre visitantes. A implementação não exige conta LangSmith nem ativa rastreamento externo.

Código: `lib/server/poet-agent.ts`, `poet-persona.ts` e `poet-knowledge.ts`. As demonstrações locais também usam primeira pessoa, mas não executam LangChain nem consultam DeepSeek.

O agente roda **sem `maxConcurrency`**, e isso é deliberado. Com o valor 1 que havia antes, uma pergunta que levasse o modelo a pedir dois tópicos do acervo no mesmo turno — "cante uma música" pedia `cancao-do-exilio` e `obras` juntos — abria o grafo em duas tarefas, das quais só uma cabia, e a execução terminava ali: ferramentas nunca executadas, nenhuma resposta composta, nenhum erro levantado. O visitante recebia um `502` e o servidor não registrava nada. A pergunta falhava em cerca de metade das tentativas. O limite também não comprava nada, porque o único nó que se ramifica é `consultar_acervo`, e ele é uma consulta a uma tabela em memória, não uma chamada que precise de contenção.

Duas defesas acompanham o conserto. `PoetAgentError` carrega um `detail` que nomeia a regra quebrada, o tamanho da fala recusada e os seus primeiros 120 caracteres, e a rota o registra no servidor — a pergunta do visitante nunca entra no log. E se o agente algum dia responder em prosa sem chamar `resposta_do_poeta`, `recoverStructuredReply` reconstrói o envelope a partir da última fala em vez de descartar uma resposta boa; só o envelope, porque o texto continua a passar pelas mesmas regras de primeira pessoa e tamanho, e continua recusado se não passar.

Referências técnicas: [agentes LangChain](https://docs.langchain.com/oss/javascript/langchain/agents), [ChatDeepSeek](https://docs.langchain.com/oss/javascript/integrations/chat/deepseek), [saída estruturada](https://docs.langchain.com/oss/javascript/langchain/structured-output).

## API interna

| Rota | Entrada | Saída |
| --- | --- | --- |
| `GET /api/status` | — | `{deepseek,openai,model,voice,mode}` sem segredos |
| `POST /api/chat` | JSON `{message,history?:[{role,content}]}` | `{text,gesture,provider:"deepseek"}` |
| `POST /api/speech` | JSON `{text,voice?,format?:"wav"\|"pcm"}` | WAV completo por padrão; PCM16 little-endian mono em streaming com `X-Audio-Sample-Rate: 24000` |
| `POST /api/transcribe` | Multipart com campo `audio` | JSON `{text}` |

Erros têm formato `{error:{code,message}}`. Mensagens aceitam até 2.000 caracteres, respostas de voz até 1.600, histórico até 12 mensagens/12.000 caracteres e gravações até 8 MB. Apenas os papéis `user` e `assistant` são aceitos no histórico. O ciclo completo do agente, incluindo consulta e correções, tem limite de 45 segundos; as demais chamadas externas também têm limite de 45 segundos e são canceladas quando o cliente interrompe a solicitação. Erros de provedores são traduzidos sem devolver payloads internos ou credenciais.

O limitador básico permite 30 solicitações por rota, por identificador, por minuto e mantém estado apenas no Worker atual. Por padrão, todas as solicitações compartilham o identificador local; `X-Forwarded-For` é ignorado. Defina `TRUST_PROXY_HEADERS=cloudflare` somente em implantação protegida por uma borda Cloudflare que sobrescreve `CF-Connecting-IP`. Nesse caso a cota usa esse IP. Uma implantação pública de maior escala deve aplicar autenticação e limite distribuído no provedor de hospedagem.

Conversas e gravações não são persistidas pela aplicação. Durante a conversa, texto/histórico são enviados ao DeepSeek e gravações/texto falado à OpenAI. O tratamento nesses serviços segue as configurações e políticas das contas usadas.

## Verificação e publicação

```powershell
npm run typecheck
npm test
npm run lint
npm run build
```

Os testes usam provedores simulados e verificam contratos, limites, cancelamento, falhas, privacidade das chaves e gestos, além de áudio progressivo antes do fim da transmissão, fragmentação PCM, reprodução contínua, fechamento da boca nas pausas, detecção do fim de fala e movimentos de olhos e pálpebras consistentes entre diferentes taxas de quadros. Uma conversa real exige chaves válidas e crédito nas duas contas.

Este projeto usa Vinext, React, Three.js e Cloudflare Workers. A configuração de Sites está em `.openai/hosting.json`. Neste projeto, as chaves ficam somente em `.env.local`, para execuções locais, conforme a preferência definida. A versão hospedada permanece sem credenciais e funciona em modo de demonstração. Não envie `.env.local` para o Git ou a hospedagem. Preserve os arquivos `.blend` originais na pasta acima do projeto; o navegador usa a versão GLB exportada em `public/models/`.

Referências: [DeepSeek Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion/), [OpenAI — geração de voz](https://developers.openai.com/api/docs/guides/text-to-speech), [OpenAI — transcrição](https://developers.openai.com/api/docs/guides/speech-to-text), [Cloudflare — variáveis locais](https://developers.cloudflare.com/workers/local-development/environment-variables/).


As quatro falas prontas da demonstração foram geradas com a voz Cedar da OpenAI e ficam em `public/audio/`. Reproduzi-las não chama nenhum provedor nem exige chave. A demonstração continua identificada e não gera respostas novas. O GLB do navegador tem cerca de 12,35 MiB, 191 mil triângulos, 48 ossos e 3 expressões de boca. Os arquivos Blender originais foram preservados.


## Articulação das mãos

O avatar mantém a aparência e as texturas do novo modelo enviado. A cópia atual `../goncalves_dias_corpo_articulado.blend` contém 30 articulações: três segmentos para cada um dos cinco dedos de cada mão. O polegar usa CMC/MCP/IP, e os demais dedos, MCP/PIP/DIP. O ciclo de diálogo do Blender também inclui movimentos dos dedos.

No navegador, cada frase abre, recolhe e relaxa os dedos, com pequenos atrasos da articulação da base até a ponta. As poses variam entre as frases e alternam a mão principal. A oposição do polegar ocorre na base, orientada pela anatomia de cada mão. As transições amortecidas mantêm velocidade contínua durante pausas e interrupções.

No aceno, ombro, cotovelo e punho levantam em sequência; a palma se volta ao visitante e os dedos se abrem progressivamente. Dois relaxamentos suaves mantêm a mão expressiva enquanto está levantada. A rotação da palma é dividida entre antebraço e punho. Anelar e mínimo esquerdos mantêm flexão e tempo coordenados para preservar a pequena ligação original da malha.

A cópia Blender inclui uma demonstração de 8 segundos a 30 quadros por segundo, amostrada do mesmo controlador do navegador com áudio local. A geometria e os pesos do GLB aprovado foram preservados; o movimento é calculado pelo controlador. Testes carregam o GLB real e medem a pele das pontas dos dedos em relação à palma, para que mover apenas o braço não seja suficiente para passar na verificação.

O GLB mantém os três controles da boca e não contém animação facial em loop. A opção de reduzir movimentos também restaura os dedos ao repouso. Os arquivos Blender anteriores continuam preservados; as chaves permanecem apenas na configuração local.


## Modelo atualizado do arquivo enviado

A versão atual usa `base_basic_pbr.glb` do arquivo `204549a9-8018-4125-9708-20ed480cbbd5.zip`. O original contém 1.216.628 vértices, 2 milhões de triângulos e uma textura de cor de 4096 × 4096. A versão PBR foi escolhida para responder à iluminação da cena.

O rig mantém 48 ossos, com pivôs e pesos dos dedos reconstruídos para as novas mãos. A posição dos lábios foi recalibrada; os três controles faciais continuam sendo acionados pelo áudio. A mão esquerda coordena os dedos anelar e mínimo, ligados pela malha original. O enquadramento usa a altura do modelo carregado.

`public/models/avatar-manifest.json` registra o arquivo de origem, seu SHA-256, a geometria exportada e a calibração facial. O Blender completo atualizado está em `../goncalves_dias_corpo_articulado.blend`; as versões anteriores permanecem disponíveis. As integrações de agente, voz, diálogo lateral e tela cheia continuam no mesmo aplicativo local.


## Refinamentos de aparência e movimento

O avatar atual usa a cópia `../goncalves_dias_corpo_articulado.blend`. As íris castanhas e as pupilas são superfícies 3D ajustadas aos olhos do modelo e vinculadas ao osso da cabeça. O olhar e as pálpebras têm controles independentes da boca, mantendo os movimentos ligados à cabeça.

A pele recebe um escurecimento suave e quente por cores de vértices em regiões selecionadas do rosto, orelhas, pescoço e mãos. A textura 4K permanece intacta. Roupa, cabelo, barba e esclera são excluídos do ajuste de cor; os materiais ganham menos brilho. O navegador preserva o acabamento próprio dos olhos.

A abertura da boca acompanha a linha real dos lábios, logo abaixo do bigode. A correção elevou essa linha em 10,5 mm e concentrou a articulação nos lábios; o queixo permanece estável. A abertura máxima do controle é de 8,5 mm, com maior mobilidade do lábio superior, alargamento e arredondamento. A sensibilidade se adapta gradualmente ao volume de cada reprodução e preserva a diferença entre sílabas suaves e fortes. O ataque mais rápido mantém sílabas curtas visíveis; as pausas fecham a boca. A análise usa o áudio efetivamente reproduzido, com janela de cerca de 21 ms e bandas calculadas pela frequência real do dispositivo. Energia e equilíbrio espectral sugerem formatos dos lábios; não há reconhecimento fonético de visemas. Os dedos usam transições amortecidas entre poses mais abertas, sem a antiga ondulação periódica; os dedos ligados da mão esquerda continuam coordenados.


## Olhar e pálpebras

O avatar alterna pequenos deslocamentos coordenados dos dois olhos com períodos olhando à frente. As pálpebras fecham e reabrem em piscadas breves, com intervalos variados e transições suaves. A atividade da fala influencia a frequência dos pequenos desvios do olhar; as piscadas seguem intervalos próprios. Não há captura de câmera nem rastreamento dos olhos do visitante.

A animação é calculada no navegador e preserva os controles de boca, cabeça e mãos. A opção de reduzir movimentos devolve olhos e pálpebras ao repouso. Retomar uma aba após uma pausa não reproduz piscadas acumuladas. No Blender, a nova cópia inclui os controles faciais e uma animação demonstrativa; os arquivos anteriores foram preservados.


## Tronco e pescoço que falam

O tronco e o pescoço ficavam parados enquanto o poeta falava, e o corpo lia-se como um boneco: em vinte segundos de fala o antebraço percorria **45°** e a coluna **0,86°**. Braços gesticulando sobre um tronco imóvel. Três coisas faltavam, e `poseSpeechTrunk` em `lib/avatar/rig.ts` as acrescenta.

**Fala é expiração.** A caixa torácica está cheia quando a frase começa e gasta quando ela acaba, reenchendo na pausa, e essa queda lenta é o maior movimento que um tronco falante faz. O rig tinha respiração, mas só a silenciosa — `idle.breath * 0.0065`, **um terço de grau** — correndo no próprio compasso, indiferente à voz.

**Nada escalava com a voz.** O peso do tronco era uma bandeira, se houve som nos últimos 0,58 s, e saturava num nível de 0,32. Uma passagem gritada e uma murmurada moviam o corpo de forma idêntica — e mediam idêntico, até a segunda casa decimal. Agora a queda da caixa torácica é proporcional ao ar gasto.

**O pescoço era um elo rígido.** Levava um sexto do giro do tronco, um quarto de grau, e a cabeça ficava sobre o peito como se aparafusada. Ele agora devolve a maior parte do que o peito toma, que é o que mantém um rosto nivelado sobre um corpo em movimento, e soma a própria parte em cada sílaba tônica.

O resultado, medido em vinte e um segundos de fala contra o estado anterior:

| osso | antes | depois | voz forte |
| --- | --- | --- | --- |
| `Coluna` | 0,86° | **2,50°** | 2,73° |
| `Peito` | 2,69° | **6,48°** | 7,02° |
| `Pescoco` | 2,21° | **4,18°** | 4,48° |
| `Cabeca` | 3,19° | **4,39°** | 4,66° |

Tudo passa por canais amortecidos, nunca lido direto do relógio, e os quatro contratos do repositório continuam de pé, medidos e não supostos: a mesma pose a 30 e a 120 quadros por segundo dentro de 0,074°; um salto de 0,015° ao voltar de uma aba oculta; e dezoito segundos depois de calar, o poeta está a **0,006°** de outro que nunca falou. Os ângulos também ficam dentro do que a pele deste scan aguenta, contra o orçamento que `work/mocap-skin-budget.mjs` mede: o peito chega a 2,7° dos seus 12, o pescoço a 1,6 dos seus 15. Os testes estão em `tests/expressive-body.test.ts`.

## Tronco e pernas durante a fala

O quadril alterna o apoio entre as pernas ao longo das frases. Coluna e peito inclinam e giram suavemente, com compensação dos ombros e pescoço. Os joelhos flexionam de forma moderada; um controlador de cinemática inversa mantém os tornozelos e a orientação dos sapatos no apoio original, evitando que as solas deslizem ou levantem. As mudanças de postura desaceleram nas pausas e a opção de reduzir movimentos restaura também a posição do quadril.

O esqueleto contém 48 ossos: os 41 anteriores, o controle de quadril e três articulações em cada perna. Apenas os pesos inferiores antes ligados à Base foram redistribuídos. A malha neutra, texturas, expressões da boca, olhos e articulações dos dedos foram preservados. Testes carregam o GLB real para medir solas e joelhos, além de verificar pausa, interrupção e consistência entre taxas de quadros.

Use o botão **Ver corpo inteiro** para observar as pernas. A cópia Blender inclui uma demonstração de oito segundos com o mesmo movimento do navegador e o áudio local de poesia já incorporado.


## Presença durante o silêncio

Quando não está falando, o personagem continua respirando, acomoda suavemente cabeça e pescoço e faz pequenos ajustes de apoio. As mãos relaxam ocasionalmente em momentos diferentes, com flexão coordenada dos dedos. Os movimentos usam sequências lentas com durações variadas e intervalos de estabilidade. A fala reduz essas acomodações gradualmente; o aceno mantém prioridade. A boca continua fechada no silêncio, enquanto as piscadas e os pequenos desvios do olhar permanecem independentes.

O relógio de repouso começa junto da animação e não avança por longas pausas de uma aba oculta. A opção de reduzir movimentos restaura a pose original. A geometria do GLB e os pesos das articulações não foram alterados.

A cópia `../goncalves_dias_presenca_natural.blend` contém uma demonstração silenciosa de 24 segundos, com corpo, mãos, olhar e pálpebras amostrados dos mesmos controladores do navegador. As ações anteriores de conversa e a gravação de voz foram preservadas nesse arquivo; o áudio fica silenciado durante a demonstração de repouso. A cópia anterior `../goncalves_dias_corpo_articulado.blend` continua disponível com a demonstração de fala.


## Ritmo da fala e olhar coordenado

Durante a fala, a cabeça não oscila mais em senoides fixas. Um detector de acentos no áudio efetivamente reproduzido identifica sílabas mais fortes que a voz recente e cada acento gera uma batida: um pequeno aceno de queixo, uma leve inclinação ou nenhum movimento de cabeça, com amplitude e sinal variados, enquanto a mão principal marca o mesmo instante com um breve movimento do punho e uma abertura extra dos dedos. Um intervalo mínimo de 260 ms evita balanço mecânico, e um nível constante não produz acenos repetidos. Cada frase assenta a cabeça em uma atitude diferente (guinada, inclinação e rolamento), com um deslocamento parcial no meio das frases longas, e começa com uma pequena inspiração que ergue o peito. As mãos alternam entre cinco colocações por frase, além da alternância da mão principal. O gesto de concordância passou a ter dois mergulhos decrescentes com leve inclinação, sem oscilar acima do repouso. No aceno, o ombro direito sobe com o braço e a cabeça inclina um pouco na direção da saudação; tronco e cabeça voltam exatamente à pose anterior.

Olhos e cabeça agora se coordenam. Quando o olhar desvia, a cabeça acompanha uma fração do desvio com pequeno atraso. Quando a cabeça se move, por respiração, atitude de frase, aceno ou batida, os olhos giram no sentido oposto para manter o contato com o visitante, como no reflexo vestíbulo-ocular, dentro de um limite confortável dos controles de olhar. Uma piscada já planejada pode ser antecipada para coincidir com uma mudança de olhar, sem encurtar o intervalo mínimo entre piscadas. A boca continua guiada apenas pelo áudio; a opção de reduzir movimentos restaura a pose original.

Os testes verificam acenos distintos em sílabas acentuadas e a ausência deles em nível constante, a consistência entre 30 e 120 quadros por segundo, o seguimento do olhar pela cabeça e sua liberação exata, a compensação ocular com o sinal correto, a forma do gesto de concordância, a participação do tronco no aceno e a variação das colocações das mãos entre frases. A geometria do GLB e os pesos das articulações não foram alterados.

A cópia `../goncalves_dias_ritmo_natural.blend` contém uma demonstração falada de 8 segundos com o áudio local de poesia, amostrada dos mesmos controladores do navegador com o acoplamento entre olhos e cabeça: ação `Fala - ritmo natural` no esqueleto, boca pela ação de poesia preservada e olhar nos objetos oculares. As ações anteriores de repouso e diálogo permanecem no arquivo; a cópia anterior `../goncalves_dias_presenca_natural.blend` continua disponível.


## Espera, escuta e pensamento

Fora da fala, o personagem deixou de apenas respirar e oscilar levemente. Em intervalos irregulares de dezenas de segundos ele traz os antebraços à frente em uma postura de descanso por alguns segundos e depois os devolve ao lado do casaco, transfere o peso de forma decidida para uma das pernas com os joelhos suavemente flexionados e o tronco em contrapeso, e respira fundo com os ombros subindo e o queixo erguendo um pouco. Os pés continuam ancorados pelo mesmo controlador de pernas, a boca permanece fechada e cada evento usa o relógio local de repouso, por isso uma aba oculta não acumula ajustes.

O personagem também reage ao momento da conversa. Enquanto o microfone grava, ele **ouve**: inclina a cabeça para um lado, aproxima-se um pouco, mantém o olhar mais fixo e, quando a voz do visitante faz uma pausa depois de um trecho falado, dá um pequeno aceno de acompanhamento, no máximo um por pausa. O nível do microfone usado é o mesmo da detecção de fim de fala e nunca sai do navegador. Enquanto a resposta e a voz são preparadas, ele **pensa**: o olhar desvia para cima e para o lado, a cabeça acompanha uma fração e o contato visual volta assim que a fala começa. Fala e repouso usam a atenção neutra; a opção de reduzir movimentos restaura a pose original e limpa esse estado.

Os testes verificam os três eventos de espera e o retorno à pose anterior com os pés no lugar, a inclinação e os acenos apenas nas pausas durante a escuta, o desvio e o retorno exato do olhar e da cabeça ao pensar, e o contato visual mais estável ao ouvir do que ao falar. A cópia `../goncalves_dias_repouso_vivo.blend` contém uma demonstração silenciosa de 75 segundos: espera, escuta de um visitante sintético, pensamento e espera novamente, amostrada dos mesmos controladores do navegador. As ações anteriores permanecem no arquivo e as cópias anteriores continuam disponíveis.


## Gabinete tridimensional

O cenário fornecido em `Visualizar_Cenario.html` foi integrado à mesma cena Three.js do personagem. Assoalho, azulejos, estante com livros, escrivaninha, cadeira, janelas, cortinas, quadros e vegetação mantêm a geometria e as texturas da referência. O gabinete recebe luz quente das janelas e preenchimento frontal suave no rosto.

A vista **Ver gabinete** abre a composição mais ampla; **Aproximar personagem** e **Ver corpo inteiro** mantêm os enquadramentos de conversa. Arrastar e aproximar continuam disponíveis dentro dos limites da sala. O modo de tela cheia mantém o gabinete, o personagem e o microfone. O painel de diálogo permanece ao lado.

O ambiente é um GLB local separado do avatar, em `public/scenes/gabinete/`, com 124.636 triângulos e 13 imagens incorporadas. As 2.218 malhas estáticas do HTML foram combinadas em 44 malhas; os vidros permanecem separados. Não há iframe, bibliotecas duplicadas nem dependências de textura externas. O manifesto inclui o hash do HTML de origem e do recurso convertido. Apenas duas luzes direcionais projetam sombras; luzes de preenchimento não geram mapas de sombras adicionais.

O carregamento acompanha a preparação do avatar, libera os recursos quando a visualização é desmontada e permite tentar novamente em caso de falha. As animações, o modelo original e as configurações de voz não foram alterados. As chaves permanecem somente no ambiente local.

A cópia `../goncalves_dias_gabinete.blend` reúne o personagem animado e o cenário, com recursos incorporados. As cópias anteriores permanecem disponíveis.

## Conversa no quadro com pedestal

O quadro de `Visualizar_Cenario (1).html` agora abriga a conversa funcional. A moldura entalhada, o pedestal torneado, as ferragens e a placa de identificação foram preservados em `public/scenes/gabinete/quadro-chat.glb`. A peça é ampliada em 30% e posicionada em primeiro plano à direita do poeta. O enquadramento **Conversar no quadro** mantém a moldura, a coluna e a base inteiras à direita do poeta, com tipografia ampliada e espaço para os gestos do personagem.

A interface utiliza o mesmo histórico, campo de texto, reprodução de voz e microfone da aplicação. Um portal React monta o chat na superfície `Tela_Chat`, acompanhando a câmera por CSS3DRenderer; o texto demonstrativo do arquivo de origem não faz parte da conversa. Rolagem, seleção de texto e navegação por teclado continuam disponíveis.

**Ampliar leitura** ou **Ler conversa** abre uma versão maior, com foco controlado e fechamento por Escape. O conteúdo permanece na mesma sessão ao abrir ou fechar essa vista. O quadro com pedestal permanece dentro do cenário também em janelas baixas, telas menores e ao mudar o zoom. O enquadramento ajusta o conjunto completo, incluindo a base, e a leitura ampliada é aberta apenas pelo botão. O modo imersivo preserva a experiência de personagem e microfone.

O pedestal contém 30.060 triângulos distribuídos em 10 malhas e três imagens incorporadas. Seu manifesto registra a proveniência e o hash do arquivo fornecido. O GLB do gabinete, o avatar e os serviços de IA/voz continuam preservados; nenhum segredo foi transferido para fora da execução local.

## Marca da Escola Educa Prime

A logo da escola aparece em dois lugares, a partir dos mesmos arquivos em `public/brand/`.

No gabinete, ela é uma placa emoldurada na parede do fundo, criada em `lib/avatar/school-branding.ts` e adicionada ao cenário em coordenadas da sala, sem alterar o GLB fornecido nem o seu manifesto. A moldura de jacarandá, o fundo creme e a arte formam três camadas de profundidade. A parede usa o lockup horizontal `educaprime-wordmark.webp`, de proporção 5,63:1, e a moldura acompanha esse formato: um letreiro de 1,52 × 0,37 m, com a arte em 1,40 × 0,25 m.

A placa fica alta, à esquerda da parede do fundo, no trecho medido livre de geometria em X = -3,92..-2,10 e Y = 2,45..3,78. A altura é o que a torna legível: o poeta tem 1,90 m e fica na origem, então qualquer letreiro na parte baixa da parede acaba atrás dele. As duas vistas usam câmeras diferentes — a de conversa é deslocada lateralmente pelo `chatLayout` para abrir espaço ao quadro, e a imersiva centraliza uma câmera bem mais próxima no poeta e esconde o quadro. Na faixa baixa da parede a arte ficava 50% a 74% coberta, ora pelo poeta, ora pelo quadro. No trecho alto ela fica 100% visível nas duas, e a moldura inteira permanece dentro do enquadramento. O teto de tamanho agora é o próprio enquadramento, não a parede: acima de 1,40 m de arte o topo da moldura começa a encostar na borda superior da vista imersiva.

No quadro, quem abre o cabeçalho do painel de conversa é o emblema `educaprime-badge.webp`, antes de "CONVERSAS COM O POETA", com um filete separando-o do título. A parede leva o lockup horizontal e o cabeçalho leva o emblema, porque ali o espaço é vertical e o título ao lado já diz o nome. Como o painel é projetado sobre a malha `Tela_Chat`, a marca acompanha o quadro dentro do cenário e também a leitura ampliada e o modo imersivo, em tamanho maior na superfície tridimensional.

As artes originais foram aparadas, reduzidas e convertidas para WebP com alfa, com PNG alternativo para navegadores sem suporte no cabeçalho. O manifesto `public/brand/manifest.json` registra a origem, os hashes, as dimensões e onde cada arquivo é usado. Os testes de `tests/school-branding.test.ts` verificam a folga na parede, o encosto no reboco, a proporção da arte, a ausência de z-fighting entre as camadas e a liberação da textura ao descartar a placa.

## Presença contínua e não repetida

O poeta parado não repete um ciclo. Cada sequência de pose em `lib/avatar/idle-motion.ts` — olhar, inclinação, rolagem, apoio, profundidade, mãos, antebraços, transferência de peso e suspiro — tem o seu próprio comprimento fixo, e sozinhas elas voltariam ao mesmo estado num ciclo previsível. Um modulador lento desloca a fase de cada uma por até ±2,6 s, com três períodos (23,7 s, 37,9 s e 61,3 s) cujo múltiplo comum só se fecha depois de cerca de sessenta dias. Na prática as sequências nunca voltam a se alinhar da mesma forma numa sessão.

O modulador é ancorado em zero no instante inicial. Sem isso o poeta começaria no meio de uma sequência, já inclinado, em vez de ganhar vida a partir do repouso — foi o que o teste do olhar apontou durante a implementação.

A respiração agora varia de fôlego para fôlego. Em vez de encurtar o ciclo diretamente, o que cortaria a curva na virada, o relógio da respiração é deformado de forma contínua e monótona: os intervalos medidos ficam entre 4,9 s e 5,7 s, todos diferentes, sem descontinuidade.

Foi acrescentada a oscilação postural que um corpo de pé nunca perde: poucos milímetros na pelve em dois eixos, com o peito contra-rotacionando levemente, em relógios próprios. É o que separa uma figura viva de uma figura posada.

Tudo continua sendo função pura do tempo: nada acumula entre quadros, a mesma instância devolve sempre a mesma pose, o resultado independe da taxa de quadros e as amplitudes originais foram preservadas — mais vida, não mais agitação. Os testes estão em `tests/idle-realism.test.ts`.

## Movimentos de contexto

Os três movimentos que o app faz em resposta a algo — acenar, gesticular durante a fala e caminhar — seguem o mesmo princípio do repouso: cada elo da cadeia atrasa em relação ao que o dirige, e nada é perfeitamente simétrico.

O aceno já escalonava braço, antebraço e mão (0 s, 0,10 s e 0,26 s). O que faltava era a oscilação, que era um seno de frequência fixa e lia como metrônomo: agora a batida afrouxa conforme o gesto assenta e nenhuma passagem alcança a mesma altura da anterior.

Na caminhada os braços deixaram de acompanhar as pernas em fase perfeita. O balanço do braço atrasa 12% do tempo de passo em relação à perna oposta, cerca de cinquenta milissegundos, que é a defasagem de um passo humano. O atraso é lido da fase, não guardado em estado: antes de vencer o atraso o braço ainda está na cauda do passo anterior, que era a outra perna e já está perto do repouso, de modo que os dois se encontram em zero e não há salto na virada. Os dois braços também deixaram de ser espelho exato — o lado que acompanha carrega 93% da amplitude do outro.

Os testes em `tests/contextual-motion.test.ts` verificam que o pico do braço vem depois da metade do passo, que os braços se opõem sem serem idênticos, que a caminhada é reproduzível, e a continuidade pelo critério honesto: num sinal contínuo o maior avanço entre quadros cai pela metade ao dobrar a taxa de quadros, enquanto uma descontinuidade real não encolheria.

## Sacadas e microssacadas

O olho real não desliza: salta. Duas mudanças em `lib/avatar/eyes.ts` fazem o olhar do poeta se comportar assim.

A transição entre fixações passou a seguir a *sequência principal* das sacadas: cerca de 21 ms mais 2,2 ms por grau de amplitude, com piso de 45 ms e teto de 90 ms. Antes ela durava 160–260 ms fixos, que é velocidade de perseguição suave — por isso o olhar parecia deslizar. O piso fica um pouco acima do mínimo fisiológico de propósito: a 30 fps um quadro dura 33 ms, e um salto concluído dentro de um único quadro renderiza como teleporte. A amplitude é medida na unidade real do morph (0,167 rad ≈ 9,6°), derivada da constante que já existia, não assumida.

Durante a fixação o olho nunca fica parado: faz microssacadas de 0,1° a 0,45°, com ~20 ms de duração, a cada 0,5–1,5 s. Sem isso a íris lê como vidro. Elas somem nos 80 ms antes e depois de cada sacada, porque não coexistem com uma — e esse fade é calculado só a partir de tempos absolutos já agendados, então é contínuo e idêntico em qualquer taxa de quadros.

As microssacadas têm o seu próprio fluxo de números pseudoaleatórios, ao lado dos de piscar e de olhar. O comentário do `random()` já explicava o motivo: fluxos separados mantêm a ordem dos eventos independente da taxa de quadros mesmo quando dois deles caem no mesmo quadro. Um primeiro rascunho compartilhava o fluxo do olhar e o teste de 30 versus 120 fps pegou a divergência.

Três asserções existentes foram reescritas para a propriedade que realmente protegem. "Olhar central" deixou de ser zero exato — que nenhuma microssacada satisfaz — e passou a ser "dentro de uma microssacada do centro", quatro vezes menor que a menor mirada planejada. O limite de passo por quadro, calibrado para os deslizes antigos, virou "nunca um teleporte de um quadro só": uma sacada real ocupa vários quadros, então os vizinhos do maior passo também estão em movimento, o que um glitch não tem. E a retomada de aba oculta continua exigindo pálpebras abertas e nenhuma mirada replicada, mas permite que a íris microssaque.

## Corpo que fala e mão que acena

Dois defeitos observados no app: as mãos ficavam estáticas durante o aceno, e tronco e pernas ficavam estáticos durante a fala. As duas causas eram de código, não de percepção.

Na fala, o peso do movimento ocioso do corpo era `1 − speaking`: falar desligava balanço, transferência de peso e respiração no tronco, e nada dirigido pela voz entrava no lugar — sobrava uma pose fixa por par de frases. As pernas, que só se articulam quando a pelve se move (IK de pé plantado), congelavam junto. Agora `poseBody` recebe dois pesos: os comportamentos de espera (transferência decidida de peso, antebraços à frente) continuam cedendo à fala, mas a vida postural — balanço, apoio, respiração — segue com 55% da amplitude enquanto ele fala. E a fala acrescenta o seu: cada sílaba tônica chega ao tronco um instante depois da cabeça como um pequeno pulso à frente e um mergulho na pelve, que as pernas plantadas absorvem; e dentro de cada frase o peso vai para o lado que conduz e volta, em vez de segurar a pose até a próxima frase.

No aceno, os dedos iam a uma pose-alvo constante e só relaxavam em dois pulsos breves; a palma oscilava, os dedos não. A fórmula do balanço da palma virou uma função pura (`waveSwing`), que os dedos reamostram 30 ms atrás da palma, cada um com o seu atraso de junta: seguem o balanço em vez de copiá-lo, abrindo um pouco no curso para fora e curvando no curso de volta — cerca de dez milímetros na ponta do dedo mais longo. As amplitudes foram dimensionadas para que, com o pulso de relaxamento no pico e o curso para dentro, cada junta continue claramente estendida além da curva do escaneamento, e o curso para fora apenas encoste no limite da junta.

Três erros meus no caminho, todos pegos pela suíte: uma versão do deslocamento de peso usava `sin(elapsed)` com `elapsed = Infinity` antes da primeira frase, e `NaN × 0 = NaN` atravessou a pelve até o teste de caminhada lateral; a versão seguinte, no relógio absoluto, sobrevivia à quantização da batida entre 30 e 120 fps mas não reiniciava como um avatar novo ao reativar o movimento; e a primeira métrica do teste da mão media distância escalar ao punho, cega ao movimento perpendicular que a flexão produz — reportava 1,8 mm para um deslocamento real de 10 mm. O deslocamento de peso ficou no padrão de `turn` (lado × envelope da frase, amortecido), que atende aos dois requisitos, e o teste mede a extensão 3D da ponta no referencial da palma.

Os testes estão em `tests/expressive-body.test.ts`: pelve viva na fala com uma fração clara do movimento em silêncio; joelhos articulando; sílabas tônicas dobrando a velocidade vertical média da pelve em relação a um nível de voz constante; e dedos com ao menos 5 mm de respiração e quatro reversões na janela do balanço, sem platô contra um clamp. Os limites do autor original — dedos estendidos além da curva, travel abaixo de 14 mm, solas plantadas, estabilidade entre taxas de quadros, reinício limpo — continuam todos valendo.

## Camada inercial

O que fazia o movimento parecer robótico, mesmo depois de atraso, assimetria e não repetição, era estrutural: cada canal era dirigido diretamente por um envelope, e os envelopes chegam ao alvo e param mortos. Um corpo não faz isso. A camada inercial em `lib/avatar/rig.ts` muda o contrato nos dois pontos por onde toda pose passa. Toda rotação que o rig pede (`rotate`, `rotateLocal`) deixa de ir ao osso e passa a ser o *alvo* de uma mola amortecida por osso e eixo; o que chega ao osso é o estado da mola. E toda mira de membro (`aim`, que é como cada pose de braço é feita — aceno, gestos de fala, ocioso, caminhada) passa os seus quatro escalares pela mesma camada: a direção, para que a mão atrase a oscilação do aceno, e o peso da mistura, para que uma elevação ganhe velocidade, passe um pouco do ponto e assente. O peso pode correr ligeiramente fora de 0..1 — o `slerp` então extrapola, que é o braço passando da marca e voltando — com as bordas como batentes. Este segundo ponto foi um buraco na primeira versão: o teste de follow-through que eu mesmo escrevi mediu 3 µrad de movimento no braço depois do comando, e o braço era justamente o gesto mais robótico. Um membro chamado a mover-se ganha velocidade, passa um pouco do ponto e assenta; cada elo da cadeia atrasa o elo que o dirige. A posição da pelve passa por três canais pesados. As pernas ficam de fora: o IK de pé plantado é dono delas, e um sapato que atrasa o alvo desliza.

A dinâmica varia por parte: dedos leves e rápidos (ω 22), mãos, antebraços e braços com rigidez de músculo (18, 16, 14) — não de pêndulo, que foi o primeiro erro de calibração: com ω 8 o braço descia do aceno 0,2 rad atrás do envelope —, cabeça e pescoço bem amortecidos (ζ 0,82) para não balançar após cada sílaba tônica, pelve e tronco lentos. Um site pode pedir seu próprio perfil por etiqueta no nome, como `Cabeca#nod`: o nod é músculo do pescoço disparando, não massa assentando, e passa quase sem inércia para continuar caindo sobre a sílaba que o causou. A leve inclinação de tronco que acompanha o aceno (`#lean`) também tem perfil próprio: é voluntária e minúscula, e com a dinâmica lenta da postura ainda estaria assentando muito depois de o braço ter parado — e como o braço é mirado em espaço de mundo compensando o pai, qualquer resíduo do tronco aparece inteiro no braço.

Vários sites dirigem o mesmo osso e eixo num quadro (a cabeça pela postura, pelo olhar e pelo nod); cada um tem a sua mola, e como a mola é linear a soma das partes suavizadas é igual à suavização da soma. Avançar uma mola duas vezes no mesmo quadro seria errado, e um carimbo de quadro lança erro se acontecer — a suíte denuncia qualquer site que fique sem etiqueta. Sites que só rodam durante um gesto deixariam a mola órfã com um resíduo que sumiria num quadro; uma varredura ao fim do `update` conduz esses canais a zero e aplica o resíduo, e o movimento decai como começou. Foi o que tirou o salto do punho a 2,008 s no aceno interrompido. Os órfãos usam um perfil de assentamento mais rígido que o do gesto: um membro cujo gesto acabou está caindo para um repouso apoiado, que a gravidade e o ombro amortecem mais depressa do que uma elevação controlada, e a cauda depois de o envelope zerar tem um par de graus no máximo. Sem isso o braço direito ainda estava 5e-6 rad fora do repouso 0,75 s após o aceno, e o contrato do autor pede 1e-6.

Quatro contratos do repositório exigiram engenharia, não afrouxamento. Fps: uma mola alimentada só com o valor do alvo ao fim do quadro vê o alvo 12 ms mais tarde a 30 fps do que a 120, e a fala divergia entre as duas taxas; a mola integra o alvo como rampa (*first-order hold*), em forma fechada, e as duas taxas caem na mesma curva. Retorno exato ao repouso: física converge assintoticamente; quando o resíduo fica abaixo de 1e-7, a mola assenta exatamente, sem traço visível. Batentes de junta: encostar no limite zera a velocidade, como `dampChannel` já fazia. Aba oculta: em repouso o relógio pausa e os alvos ficam onde estavam, então a mola segura a pose exibida e retomar não salta; envelopes de gesto correm no relógio de parede e pulam de fase, então uma mola que deslizasse atrás deles inventaria movimento — ela é assentada no alvo. O próprio canal distingue os dois casos: só um alvo que se moveu apreciavelmente através da lacuna pulou. Timestamp repetido não é lacuna e nunca chega a esse ramo.

Nenhum teste do autor foi afrouxado. Cheguei a renegociar um — o braço idêntico ao repouso 10 ms após o fim do fade — e a regra de lacuna o tornou desnecessário, então o restaurei. Os testes novos estão em `tests/inertial-layer.test.ts`: o braço continua a mover-se depois que o comando do aceno já parou e depois assenta; nenhum site avança uma mola duas vezes em repouso, fala, aceno e caminhada; e o aceno — o gesto mais rápido — chega ao mesmo lugar a 30 e a 120 fps, cobertura que não existia para gestos.

## Movimento capturado

A camada inercial deu ao movimento construído a física que lhe faltava, mas continuava a ser movimento construído: um envelope decide quando o braço sobe, e nenhuma soma de envelopes contém o que um corpo faz sem que ninguém o tenha decidido. Os clipes em `public/models/clips/` vêm da Mixamo e trazem isso pronto. `lib/avatar/mocap.ts` os toca; `work/build-mocap-clips.mjs` os gera a partir dos FBX na raiz do repositório.

O transporte entre esqueletos é **delta de rotação em espaço-mundo medido a partir da pose de repouso de cada rig**, nunca cópia de rotação local. Os dois esqueletos partilham as proporções — a Mixamo rigou o próprio scan do poeta, e a `BindPose` dela cai a menos de 1 cm da nossa em cada junta — mas não as bases dos ossos, que diferem 98° no braço e 180° na coxa. Copiar rotação local produziria lixo. Como o delta é medido no mundo, uma junta que não temos não se perde: a clavícula, o elo extra da coluna e os dedos dos pés já estão dentro da rotação de mundo do osso seguinte, que os absorve. A aferição está em `work/mocap-verify.mjs` e compara a direção de cada osso entre a animação da Mixamo e o nosso esqueleto: a diferença é **constante até a quarta casa decimal** em todos os elos, e o que resta dela é a diferença de postura parada entre os dois rigs, que o delta preserva de propósito — o poeta mantém a própria postura e o movimento entra por cima. O único canal que varia é `Coluna→Peito`, em 1,2°, porque é ali que o `Peito` absorve a `Spine1` que não temos.

Dois defeitos de decodificação precisaram de prova, não de opinião. O FBX guarda rotação em Euler, e a ordem padrão `eEulerXYZ` compõe a matriz como `Rz·Ry·Rx`, que em three.js se escreve `"ZYX"`. Lendo como `"XYZ"` as duas quase coincidem enquanto os ângulos são pequenos — o aperto de mão passava — e divergem por completo perto do gimbal: a caminhada dá uma volta inteira, o quadril fica em Y ≈ -83°, e o corpo virava de cabeça para baixo, com a cabeça a 35 cm e os pés a 1,78 m. A prova independente é a `BindPose`, que o arquivo guarda como matriz crua: a pose de repouso reconstruída a partir dos Euler tem de bater com ela, e bate em **0,00 cm** com `ZYX` contra 59 cm com `XYZ`. O segundo defeito é meu: um eixo sem curva própria não vale zero, vale o padrão que o `AnimationCurveNode` guarda em `d|X/Y/Z`, e lê-lo como zero arranca o membro do repouso.

### Orçamento de dobra

Um clipe capturado pede ângulos em que este avatar nunca foi posto. Ele é um scan fotogramétrico, e onde dois ossos dividem um vértice a pele é uma mistura dos dois: dobre a junta o bastante e a mistura colapsa para dentro. **Pescoço e cabeça dividem 9286 vértices** — o maxilar, o queixo, a base do rosto, um quinto de tudo o que a cabeça carrega. As fontes dobram essa junta em 52°, e a esse ângulo o pior desses vértices afunda **14 mm**. Foi o rosto que se viu distorcido no primeiro cumprimento. O rig procedural nunca havia pedido a essa junta mais do que 0,4°, então nada tinha mostrado o problema antes.

`work/mocap-skin-budget.mjs` lê os pesos direto do GLB, põe os vértices partilhados em pose e mede o que eles perdem, para que o limite venha da malha e não do gosto:

| junta | vértices partilhados | perda a 30° | perda a 60° | limite |
| --- | --- | --- | --- | --- |
| `Pescoco→Cabeca` | 9286 | 4,7 mm | 18,5 mm | **15°** |
| `Peito→Pescoco` | 3178 | 4,5 mm | 17,7 mm | **15°** |
| `Coluna→Peito` | 3666 | 7,6 mm | 29,8 mm | **12°** |
| `Base→Coluna` | 3802 | 7,9 mm | 30,9 mm | **12°** |
| `Antebraco→Mao` | 914 | 2,4 mm | 9,3 mm | **39°** |

O rosto e a cadeia que o carrega são mantidos numa perda de 1,2 mm, que não se vê à distância de conversa. O punho, que um cumprimento põe à frente da câmera, é mantido em 4 mm. Ombro, cotovelo, quadril e joelho ficam livres: partilham poucos vértices ou nenhum — `Coxa` não divide nenhum com o pai —, estão sob roupa, e a caminhada procedural vem dobrando o joelho a 40° desde sempre. O limite é aplicado na geração **encolhendo o movimento inteiro da junta**, nunca cortando os picos. A primeira versão cortava quadro a quadro, e uma junta cortada não se move: fica no batente enquanto o corpo em volta continua, e se solta de uma vez. Medido, os clipes de fala deixavam um punho preso no limite 45% do tempo e a cabeça 45%, e a caminhada prendia a coluna 72% — juntas congeladas no meio de um movimento vivo, que foi o que se viu como desengonçado. Agora cada junta que passa do orçamento tem toda a sua amplitude reduzida na proporção exata que a faz caber, com 5% de folga para a respiração, o olhar e os acenos por cima; o ritmo e a forma do gesto ficam, só o tamanho muda, e nenhuma junta para. O limite duro do runtime (`holdBudget`) continua como última defesa e, com a voz real, nunca chega a agir. Nos clipes de fala o quadril também é centrado na horizontal, para a transferência de peso oscilar em torno do repouso; na vertical fica como o ator fez, 2 cm abaixo, porque é essa folga nos joelhos que deixa o quadril ir 7 cm para o lado com os dois pés no chão. Cada clipe grava o que pediu e a escala aplicada, e os testes verificam tanto que nenhuma junta passa do orçamento quanto que o orçamento é de facto o que segura — um guarda que nunca fosse alcançado não provaria nada.

### Os clipes

**Cumprimento** (4,37 s) **não** substitui o aceno. Chegou a substituir, e foi um erro de julgamento meu: um aperto de mão não é um aceno, e pôr um no lugar do outro apenas fez o aceno deixar de ser um aceno. `gesture("wave")` continua a ser o aceno construído; o cumprimento toca por `playClip("cumprimento", now)`, à espera de um momento que seja dele. Um clipe `Waving` da Mixamo entraria no lugar do aceno de forma legítima e leva minutos para acrescentar. Ele traz o próprio deslocamento de raiz porque dá um passo à frente e volta exatamente ao ponto de partida — o pé apoiado escorrega 1,6 cm/s, ou seja, está travado no chão —, então dirige também as próprias pernas e o solucionador de pé plantado recolhe-se enquanto ele corre. As camadas procedurais continuam a somar por cima: medido osso a osso, o que elas acrescentam é **0,99° na cabeça** e menos de 0,4° em todo o resto. A captura é o que se vê; a respiração e o olhar continuam lá.

**Caminhada** (17,37 s) entra sozinha enquanto a navegação corre, e **do quadril para cima, sem o quadril**. A medição decidiu: o pé apoiado da caminhada procedural não se move nada, porque o solucionador o segura, enquanto o clipe inteiro o arrasta 7 cm por segundo. Emprestando apenas o tronco fica-se com os dois — o solucionador continua dono do chão, com o mesmo resíduo de meio micrômetro por segundo, e o tronco, os braços e a cabeça passam a carregar **cinco vezes** o movimento que carregavam. A pelve fica de fora junto com as pernas, e não só por arrumação: endireitar uma curva capturada deixa resíduo na raiz e em mais lado nenhum, e ele balançava o poeta 24° enquanto ele andava em linha reta. Tirá-la também soltou a IK, que torcia a coxa 29° para alcançar o mesmo pé e agora torce os mesmos 17° de antes.

O clipe é um laço fechado: o quadro 0 e o quadro 521 diferem em 0,00008°, treze passadas de variação natural em vez de um ciclo de 1,3 s a repetir-se, que era justamente a repetição a combater. A fonte anda em círculo, então a guinada do percurso é removida — a do percurso, não a do quadril, cuja oscilação a cada passo é balanço real e fica. Essa distinção custou caro: a direção era lida numa janela de ±6 quadros, e como o quadril balança para os lados quase tanto entre passos quanto avança entre quadros, o balanço dominava a leitura. A guinada parecia oscilar a 176°/s, e tirá-la do corpo não removeu curva nenhuma — cravou uma em cada osso, deixando a pelve do clipe pronto a girar 41° e a cabeça 47°, quando a cabeça de quem caminha é a parte mais firme da pessoa. Lida sobre uma passada inteira, a taxa de giro é 19,4°/s na mediana. O que a remoção custa é mensurável: no referencial do trajeto, a inclinação lateral do tronco é de **0,84°** em média, porque a caminhada é lenta demais para acumular inclinação centrípeta.

Um clipe em-lugar avança por **chão percorrido**, não pelo relógio. A velocidade não é constante dentro de uma passada — cai a cada toque de calcanhar, entre 0,45 e 1,16 m/s numa média de 0,82 —, então tocá-lo a ritmo fixo arrasta o pé mesmo na velocidade média exata. Dirigido por distância, andar mais devagar baixa a cadência em vez de virar câmera lenta.

O clipe não passa pelas molas. Ele já traz a inércia do corpo de onde foi capturado, e suavizar movimento real só lhe tira a vida; o que a camada inercial continua a fazer é tudo o que soma por cima dele. O rig reserva 0,28 s para entrar e outros tantos para sair, e um clipe que não carregue deixa o poeta com o gesto construído que ele substituiria — nunca sem gesto nenhum.

Duas limitações herdadas da fonte, registradas para quem vier depois. O rig da Mixamo só traz **polegar e indicador**, então médio, anelar e mínimo continuam na camada procedural durante os clipes. E os FBX vieram *With Skin*, 40 MB cada, dos quais só as curvas de osso são lidas — baixar *Without Skin* dá o mesmo resultado em 200 KB.

Para acrescentar um clipe: ponha o FBX na raiz, adicione uma entrada em `SOURCES` no gerador dizendo se a raiz é `keep` ou `inPlace`, rode `node work/build-mocap-clips.mjs`, e inclua o nome em `MOCAP_CLIPS` no `AvatarStage`. Se ele dobrar uma junta nova para além do seguro, meça-a com `node work/mocap-skin-budget.mjs` e acrescente-a a `BEND_BUDGET`. Os testes estão em `tests/mocap.test.ts` (formato, laço, travamento do pé por distância em três velocidades, orçamento de dobra) e `tests/mocap-rig.test.ts` (o cumprimento leva a mão mais longe que o aceno construído, move o corpo todo e devolve a pose ao repouso; a caminhada engata e solta sozinha sem tirar o pé do chão).

### A captura como régua

Com só dois clipes disponíveis, a Mixamo serve também de régua. Uma análise orquestrada mediu, com as **mesmas métricas dos dois lados**, o movimento capturado contra o procedural — dobra de cada junta, giro total, frequência dominante, atraso entre juntas, estabilização da cabeça — em repouso, fala, aceno e caminhada. Encontrou nove suspeitas, e cada uma passou por três céticos independentes: um que a remediu do zero com script próprio, um que checou se a diferença era decisão deliberada de projeto, e um que converteu a diferença em deslocamento na tela à distância real da câmera. **Seis sobreviveram.** As três refutadas eram de fala e repouso, e caíram em parte porque não há captura de fala para comparar.

O que se corrigiu, cada item medido antes e depois:

- **A caminhada nunca chegou ao peito nem ao pescoço.** A exclusão das pernas era a regex `/^(Quadril$|Coxa.|Canela.|Pe.)/`, os escapes perdidos na gravação, e `Pe.` casava com **Pe**ito e **Pe**scoco. Os dois ficavam 4,4° longe do clipe; hoje ficam a 0,90° e 0,24°. É agora um conjunto exato, que não casa por prefixo.
- **Os braços balançavam em dobro.** O balanço procedural era somado por cima do capturado: o braço desviava 3,43° em média e 7,51° no pior quadro, e o antebraço 4,01° constantes — os 0,07 rad do procedural, na casa centesimal. Cede agora ao clipe na proporção do peso dele: 0,18° e 0,38°.
- **O tronco andava em outro compasso que as pernas.** Tocado por distância a 0,42 m/s, o clipe balançava a 0,39 Hz sobre pernas passando a 0,91, e congelava nos giros no lugar, que não cobrem distância. O andarilho expõe agora `stridePhase`, a contagem contínua dos toques de calcanhar, e o gerador grava os 26 toques do próprio clipe (detectados pela separação ântero-posterior dos pés, alternando sem falha); o tronco toca no compasso das pernas, pé com pé. Frequência dominante 0,893 Hz, a banda lenta caiu para 1-4% do pico, e o balanço lento da mão de 13,7 cm para 0,80.
- **A cabeça do clipe girava 49,7°.** A fonte anda em círculo e olha para dentro da curva. `steadyHead` tira 70% da guinada que **o clipe** deu ao rosto, medida logo após aplicá-lo e antes do olhar — que também gira a cabeça e mantém cada grau que pede. Hoje são 15,9° no total e 6,7° por passada. E `holdBudget` dá a palavra final sobre a dobra de cada junta depois de todas as camadas, contra a mesma tabela que o gerador usa, `lib/avatar/bend-budget.json`: a cabeça ia a 15,9° com orçamento de 15.
- **O aceno era um braço isolado.** O rosto mexia 4,7 px em relação à pelve na câmera da conversa (a captura mexe até 34) e o braço livre, nada. A coluna agora carrega a inclinação, o pescoço e a cabeça acompanham, o braço esquerdo abre um pouco: rosto 15,4 px, punho livre 24,9 px, e o peito dentro dos 0,05 rad que o teste do autor permite.
- **O braço erguido ficava parado como articulação.** Durante a sustentação ele variava 0,006°. Três senos incomensuráveis entre 1,3 e 3 Hz, a faixa em que os músculos de um braço erguido procuram o alvo, levam isso a 0,77°.
- **A caminhada de reserva**, a que roda se o clipe não carregar, balançava o braço como uma vara: o cotovelo não se movia. Agora antebraço e punho seguem o ombro com atraso — 117 ms do ombro ao cotovelo, medidos entre as velocidades das próprias articulações (a captura: 83) — e o cotovelo sozinho leva o punho 11,6 cm por passada, contra 11,0 da captura. Eles correm no relógio contínuo da marcha e não no do balanço, que para durante o apoio duplo: lidos dali, o antebraço estaria a 73% do balanço no fim dele e cairia a zero num quadro, a cada passo. E só leem balanços da caminhada em curso; alcançar mais atrás encontrava, no primeiro passo, um passo que nunca foi dado.
- **Os clipes eram tudo ou nada.** Um que não chegasse derrubava os outros. Agora cada um chega ou falha sozinho, e cada falha é relatada.

Dois contratos precisaram de conserto próprio no caminho. O fade da caminhada capturada corria no relógio a partir do quadro que primeiro viu a marcha — 8 ms a 120 fps, 33 ms a 30 — e a mão divergia 4,3° entre as taxas; o peso do clipe agora segue o peso da própria marcha, que o andarilho integra a 120 Hz fixos. E o repouso exportado no manifesto não tem norma exatamente unitária: o ângulo de um quaternion de repouso **consigo mesmo** dá 0,00066 rad, então o limite normaliza as duas pontas antes de comparar.

Limitações que ficam, registradas para quem vier depois. Girando no lugar, o tronco agora acompanha os passos com o movimento de uma caminhada inteira (33°/s na coluna, contra 2 sem clipe): o poeta parece andar no lugar ao girar. E "Walk In Circle" continua sendo a fonte: a cabeça segue perto do seu orçamento e a coluna no limite de 12° em boa parte dos quadros, porque a fonte olha para dentro da curva. Um clipe **`Walking`** reto resolve os dois; um **`Waving`** daria ao aceno tronco, cabeça e braço livre capturados. Ambos entram pelo gerador sem código novo.

Os testes estão em `tests/mocap.test.ts`, `tests/mocap-rig.test.ts`, `tests/expressive-body.test.ts` e `tests/contextual-motion.test.ts`.

### A fala capturada

O tronco e o pescoço pareciam parados durante a fala mesmo depois da camada `poseSpeechTrunk`, e a medição mostrou por quê. Reproduzindo a análise do `SpeechPlayer` sobre a gravação real da voz do poeta, a camada ligava normalmente — o nível mediano é 0,45 — e girava o peito 5,6°, mas na câmera da conversa isso virava **15 px de deslocamento do rosto em 18 s de fala, e 2 px na vertical**. A mão percorria 57 px. Um corpo parado e braços se movendo sozinhos, em batidas procedurais que se leem como mecânicas.

`fala-1` e `fala-2` vêm de dois clipes "Talking" da Mixamo, ambos laços perfeitos (o último quadro é o primeiro a 0,00°). Entram sozinhos quando o poeta fala, do quadril para cima, alternando entre um trecho de fala e o seguinte. O primeiro traz **12 cm de transferência de peso** de uma perna para a outra: esse deslocamento do quadril vai para a pelve, e o solucionador de pé plantado mantém os sapatos no chão — 0,0 mm de elevação e de deslize. Os braços da conversa, o tronco da fala e os braços ociosos cedem ao clipe na proporção do peso dele; o olhar e os acenos de cabeça nas sílabas continuam, porque são eles que seguem o áudio e o interlocutor.

Com a mesma voz real e a mesma câmera, o rosto passa a percorrer **82 × 25 px** e o esterno 64 × 18. O rosto continua voltado para quem conversa: desvio mediano de 3°, máximo de 11°.

Três decisões tiveram medida por trás:

- **O peso segue a presença de fala, não a sílaba.** Seguindo o envelope da voz, o corpo saía metade da postura a cada pausa de 0,2 s entre palavras, bombeando para dentro e para fora da fala. Agora um canal amortecido vale 1 enquanto houve voz nos últimos 0,6 s: atravessa as pausas e se desfaz depois da última palavra. Isso também levou a divergência entre 30 e 120 fps com a voz real de 0,11 rad para 0,015.
- **O clipe corre no relógio absoluto.** Num dado instante ele mostra o mesmo momento a qualquer taxa de quadros, e cada trecho de fala abre onde o laço estiver, então nenhum começa igual ao outro. No protocolo de paridade do autor (voz constante de 0,42 por 22 s), o resultado é idêntico com e sem clipes: 0,00105 rad, contra o limite de 0,004. Num sinal mais áspero, com sílabas e pausas, o rig procedural sozinho diverge 0,33 rad entre as taxas, porque seus gestos disparam em quadros diferentes; com o clipe, 0,019.
- **O ombro entrou no orçamento de dobra, em 44°.** O clipe levava o ombro esquerdo a 72°, e pela medição de pele isso afunda uns 45 mm na axila e no ombro. O aceno procedural já publicado chega a 43,2°, então 44° é o limite do que o avatar já faz: o clipe nunca afunda a pele além disso, e o aceno fica intacto. A mesma regra conteve a caminhada, que pedia 54,6° no ombro esquerdo — o braço à deriva que o percurso circular deixava.

Os testes estão no bloco "a fala capturada" de `tests/mocap-rig.test.ts`.

## Caminhada pelo gabinete

O botão **Caminhar** abre os controles de passeio e uma vista ampla pela entrada do gabinete. Clique ou toque em um ponto livre do piso, ou escolha um dos destinos no menu e pressione **Ir**. Arrastar continua controlando a câmera; um arrasto, clique em móvel ou seleção no chat não inicia passos. O marcador dourado indica o destino atual. O menu também permite navegar usando teclado.

**Parar** desacelera e conclui o passo; Escape com foco no cenário ou nos controles também interrompe o passeio. **Voltar ao quadro** leva o poeta caminhando à posição inicial e, após a chegada, restaura o enquadramento da conversa. Um novo destino pode ser escolhido durante o trajeto. Os comandos explícitos de passeio ativam os movimentos; ao desativar gestos, fechar os controles ou entrar no modo imersivo, ele termina a caminhada em andamento.

A navegação usa o piso e os limites do gabinete fornecido, com uma margem corporal de 55 cm ao redor dos móveis e do pedestal. Caminhos com desvios são calculados localmente e seus segmentos são verificados contra obstáculos, incluindo os cantos. A caminhada combina passos alternados, apoio dos pés em coordenadas do cenário, solução das pernas por duas articulações, deslocamento do quadril, movimento oposto dos braços e viradas com passos curtos. Fala, boca, olhos, mãos e acenos continuam combinados com o movimento. Nenhuma chamada adicional às APIs é necessária para caminhar.
