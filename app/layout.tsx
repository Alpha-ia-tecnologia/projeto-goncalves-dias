import type { Metadata } from 'next';
import './globals.css';
const base = new URL('https://goncalves-dias-presenca.assistentemariasemus.chatgpt.site');
const title = 'Gonçalves Dias — Uma conversa através do tempo';
const description = 'Converse com uma representação 3D de Gonçalves Dias, com voz, expressão e gestos. Uma experiência interativa com DeepSeek e OpenAI.';
export const metadata: Metadata = {
  metadataBase: base, title, description, icons: { icon: '/icon.png' },
  openGraph: { title, description, type: 'website', locale: 'pt_BR', url: base.href, images: [{ url: new URL('/og.png', base).href, width: 1536, height: 1024, alt: 'Gonçalves Dias — Uma conversa através do tempo.' }] },
  twitter: { card: 'summary_large_image', title, description, images: [new URL('/og.png', base).href] },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="pt-BR"><body>{children}</body></html>;
}
