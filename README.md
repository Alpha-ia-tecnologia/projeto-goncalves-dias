# Gonçalves Dias — presença digital

Aplicação web com o modelo 3D do projeto Blender, conversa em português pelo DeepSeek, voz sintetizada pela OpenAI, movimento de boca durante o áudio e aceno ao ouvir cumprimentos como “olá” ou “oi, tudo bem?”. O personagem é uma representação artística, com voz gerada por IA.

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

1. Uma mensagem digitada segue para `/api/chat`; uma gravação passa primeiro por `/api/transcribe`.
2. O servidor envia a mensagem e um histórico limitado ao DeepSeek. O retorno é validado como texto e gesto.
3. O texto da resposta segue para `/api/speech`, que solicita áudio WAV ao `gpt-4o-mini-tts`.
4. O navegador reproduz o WAV e analisa sua amplitude para abrir/fechar a boca do modelo. Esse movimento acompanha o áudio, mas não é uma sincronização fonética de visemas.
5. “Olá”, “oi”, “bom dia” e pedidos de aceno disparam o gesto `wave`. A regra considera palavras completas, aceita acentos e respeita “não acene”.

Os controles de demonstração permitem conferir o modelo, a boca e os gestos antes de configurar os serviços. A síntese real usa a voz `cedar` por padrão; o modelo e a voz são configuráveis. O aplicativo não tenta reproduzir a voz histórica de Gonçalves Dias.

## API interna

| Rota | Entrada | Saída |
| --- | --- | --- |
| `GET /api/status` | — | `{deepseek,openai,model,voice,mode}` sem segredos |
| `POST /api/chat` | JSON `{message,history?:[{role,content}]}` | `{text,gesture,provider:"deepseek"}` |
| `POST /api/speech` | JSON `{text,voice?}` | `audio/wav` |
| `POST /api/transcribe` | Multipart com campo `audio` | JSON `{text}` |

Erros têm formato `{error:{code,message}}`. Mensagens aceitam até 2.000 caracteres, respostas de voz até 1.600, histórico até 12 mensagens/12.000 caracteres e gravações até 8 MB. Apenas os papéis `user` e `assistant` são aceitos no histórico. Chamadas externas têm limite de 45 segundos e são canceladas quando o cliente interrompe a solicitação. Erros de provedores são traduzidos sem devolver payloads internos ou credenciais.

O limitador básico permite 30 solicitações por rota, por identificador, por minuto e mantém estado apenas no Worker atual. Por padrão, todas as solicitações compartilham o identificador local; `X-Forwarded-For` é ignorado. Defina `TRUST_PROXY_HEADERS=cloudflare` somente em implantação protegida por uma borda Cloudflare que sobrescreve `CF-Connecting-IP`. Nesse caso a cota usa esse IP. Uma implantação pública de maior escala deve aplicar autenticação e limite distribuído no provedor de hospedagem.

Conversas e gravações não são persistidas pela aplicação. Durante a conversa, texto/histórico são enviados ao DeepSeek e gravações/texto falado à OpenAI. O tratamento nesses serviços segue as configurações e políticas das contas usadas.

## Verificação e publicação

```powershell
npm run typecheck
npm test
npm run lint
npm run build
```

Os testes usam provedores simulados e verificam contratos, limites, cancelamento, falhas, privacidade das chaves e gestos. Uma conversa real exige chaves válidas e crédito nas duas contas.

Este projeto usa Vinext, React, Three.js e Cloudflare Workers. A configuração de Sites está em `.openai/hosting.json`. Na hospedagem, cadastre `DEEPSEEK_API_KEY` e `OPENAI_API_KEY` como segredos do servidor; `.env.local` é somente para desenvolvimento e não deve ser publicado. Preserve os arquivos `.blend` originais na pasta acima do projeto; o navegador usa a versão GLB exportada em `public/models/`.

Referências: [DeepSeek Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion/), [OpenAI — geração de voz](https://developers.openai.com/api/docs/guides/text-to-speech), [OpenAI — transcrição](https://developers.openai.com/api/docs/guides/speech-to-text), [Cloudflare — variáveis locais](https://developers.cloudflare.com/workers/local-development/environment-variables/).


O áudio da demonstração foi gerado localmente com a voz Microsoft Maria (pt-BR), sem chamada aos provedores. O GLB do navegador tem cerca de 7,81 MiB, 130 mil triângulos, 11 ossos e 3 expressões de boca. Os arquivos Blender originais foram preservados.
