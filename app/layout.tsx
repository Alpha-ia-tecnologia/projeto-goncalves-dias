import type { Metadata } from 'next';
import './globals.css';
const base = new URL('https://goncalves-dias-presenca.assistentemariasemus.chatgpt.site');
const title = 'Acervo Vivo — Gonçalves Dias';
const description = 'Converse com uma representação 3D de Gonçalves Dias, com voz, expressão e gestos. Uma experiência do Acervo Vivo com DeepSeek e OpenAI.';
export const metadata: Metadata = {
  metadataBase: base, title, description, icons: { icon: '/icon.svg' },
  openGraph: { title, description, type: 'website', locale: 'pt_BR', url: base.href, images: [{ url: new URL('/og.png', base).href, width: 1536, height: 1024, alt: 'Acervo Vivo — Gonçalves Dias.' }] },
  twitter: { card: 'summary_large_image', title, description, images: [new URL('/og.png', base).href] },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="pt-BR"><body>{children}</body></html>;
}
