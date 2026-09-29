import {
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Texture,
  TextureLoader,
} from "three";

export const SCHOOL_LOGO_URL = "/brand/educaprime-wordmark.webp?v=educaprime-2";

/**
 * Room metres, the same frame the gabinete GLB uses: X across the back wall,
 * Y from the floor, Z into the room from the plaster plane at -3.60.
 *
 * The plaque hangs high on the left of the back wall, in the patch measured
 * clear of geometry at X = -3.92..-2.10, Y = 2.45..3.78. That height is what
 * makes it readable: the poet is 1.90 m tall and stands at the origin, so any
 * sign on the lower wall ends up behind him. Down in the band between the tiles
 * and the picture rail the artwork was only 50 to 74 per cent visible, split
 * between the poet in the close immersive framing and the chat pedestal in the
 * conversation framing. Up here it clears both completely.
 *
 * The size is capped by the viewport rather than by the wall: the two framings
 * use different cameras, and this is the largest board whose artwork is fully
 * visible and whose frame stays inside the picture in every one of them.
 * See tests/school-branding.test.ts, which measures exactly that.
 */
export const SCHOOL_PLAQUE = {
  /** Plaster plane of the back wall; the frame rests against it. */
  wallZ: -3.6,
  center: [-3.09, 3.52, -3.577] as const,
  frameWidth: 1.52,
  frameHeight: 0.369,
  frameDepth: 0.046,
  panelWidth: 1.46,
  panelHeight: 0.309,
  /** 1024 × 182 in the shipped texture, preserved so the wordmark is not squashed. */
  logoWidth: 1.4,
  logoHeight: 0.2488,
} as const;

export interface SchoolPlaqueOptions {
  texture: Texture;
}

export interface SchoolPlaque {
  /** Room coordinates; add it to the gabinete root to inherit its placement. */
  root: Group;
  dispose(): void;
}

function assertActive(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException("Carregamento da logo da escola cancelado.", "AbortError");
  }
}

export interface SchoolLogoOptions {
  signal?: AbortSignal;
  anisotropy?: number;
}

/** Loads the EDUCAPRIME artwork as a colour texture, ready for a lit material. */
export async function loadSchoolLogo(options: SchoolLogoOptions = {}): Promise<Texture> {
  const { signal } = options;
  assertActive(signal);
  let texture: Texture;
  try {
    texture = await new TextureLoader().loadAsync(SCHOOL_LOGO_URL);
  } catch (cause) {
    throw new Error("Não foi possível carregar a logo da Escola Educa Prime.", { cause });
  }
  // Decoding cannot be interrupted, so release it rather than leaking on unmount.
  if (signal?.aborted) {
    texture.dispose();
    assertActive(signal);
  }
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = Math.max(1, Math.min(options.anisotropy ?? 4, 8));
  return texture;
}

/**
 * Carved frame, cream mount and the school artwork, in the jacarandá and lime
 * language of the room. The logo reads as printed on the mount rather than as a
 * lit sign: a small emissive lift keeps it legible in the corner the sun misses.
 */
export function createSchoolPlaque(options: SchoolPlaqueOptions): SchoolPlaque {
  const { texture } = options;
  const root = new Group();
  root.name = "Placa_Escola_Educa_Prime";
  root.position.set(...SCHOOL_PLAQUE.center);

  const frameGeometry = new BoxGeometry(
    SCHOOL_PLAQUE.frameWidth,
    SCHOOL_PLAQUE.frameHeight,
    SCHOOL_PLAQUE.frameDepth,
  );
  const frameMaterial = new MeshStandardMaterial({ color: 0x2e1d14, roughness: 0.52, metalness: 0.05 });
  const frame = new Mesh(frameGeometry, frameMaterial);
  frame.name = "Moldura_Educa_Prime";
  frame.castShadow = true;
  frame.receiveShadow = true;

  const front = SCHOOL_PLAQUE.frameDepth / 2;
  const panelGeometry = new PlaneGeometry(SCHOOL_PLAQUE.panelWidth, SCHOOL_PLAQUE.panelHeight);
  const panelMaterial = new MeshStandardMaterial({ color: 0xf4ece0, roughness: 0.78, metalness: 0 });
  const panel = new Mesh(panelGeometry, panelMaterial);
  panel.name = "Fundo_Educa_Prime";
  panel.position.z = front + 0.001;
  panel.receiveShadow = true;

  const logoGeometry = new PlaneGeometry(SCHOOL_PLAQUE.logoWidth, SCHOOL_PLAQUE.logoHeight);
  const logoMaterial = new MeshStandardMaterial({
    map: texture,
    emissiveMap: texture,
    emissive: 0xffffff,
    emissiveIntensity: 0.16,
    transparent: true,
    // The artwork is a hard-edged sticker; testing alpha keeps its outline crisp
    // and lets it sort against the mount without a transparency pass.
    alphaTest: 0.08,
    roughness: 0.46,
    metalness: 0,
  });
  const logo = new Mesh(logoGeometry, logoMaterial);
  logo.name = "Logo_Educa_Prime";
  logo.position.z = front + 0.003;

  root.add(frame, panel, logo);

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    root.removeFromParent();
    for (const geometry of [frameGeometry, panelGeometry, logoGeometry]) geometry.dispose();
    for (const material of [frameMaterial, panelMaterial, logoMaterial]) material.dispose();
    const image = texture.source.data as { close?: () => void } | undefined;
    image?.close?.();
    texture.dispose();
    root.clear();
  };

  return { root, dispose };
}
