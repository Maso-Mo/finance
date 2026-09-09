import { inflateSync } from 'node:zlib';

/**
 * Extraction de TEXTE d'un PDF — 100 % LOCALE, sans dépendance, sans LLM.
 *
 * V1 volontairement MINIMALISTE et PRUDENT : on ne décode que les flux de
 * contenu « FlateDecode » (le cas de très loin le plus courant) et on n'en
 * retire que les opérateurs d'affichage de texte simples :
 *   - « (chaîne) Tj » ;
 *   - « [ (a) 12 (b) ] TJ » (sauts de glyphes ignorés : le TEXTE compte) ;
 *   - retours de ligne implicites via Td / TD / T* .
 *
 * Toute construction non supportée (police composite CFF, Flux d'images,
 * cryptage…) est simplement ignorée — on ne devine JAMAIS du texte. La sortie
 * est ensuite relue par la grammaire STRICTE de finance-core
 * (parseStatementText) : une extraction bruitée produit zéro ligne reconnue,
 * pas de fausse écriture.
 */

/** Un PDF doit commencer par « %PDF » et se terminer par « %%EOF ». */
export function looksLikePdf(buffer: Uint8Array): boolean {
  const source = Buffer.from(buffer);
  const head = source.subarray(0, 1024).toString('latin1');
  const tail = source.subarray(Math.max(0, source.length - 1024)).toString('latin1');
  return head.includes('%PDF-') && tail.includes('%%EOF');
}

const STREAM_RE = /stream\r?\n([\s\S]*?)\r?\nendstream/g;

/** Décode les chaînes simples « (…) » (sans échappements complexes). */
function decodePdfString(raw: string): string {
  return raw
    .replace(/\\([nrtbf()\\])/g, (_all, char: string) => {
      switch (char) {
        case 'n': return '\n';
        case 'r': return '\r';
        case 't': return '\t';
        case 'b': return '\b';
        case 'f': return '\f';
        default: return char;
      }
    })
    .replace(/\\\d{1,3}/g, '');
}

/**
 * Extrait le texte affichable d'un PDF (FlateDecode + Tj/TJ uniquement).
 * @throws si le tampon n'est pas un PDF (refus explicite, jamais de devinette).
 */
export function extractPdfText(buffer: Uint8Array): string {
  if (!looksLikePdf(buffer)) {
    throw new Error('Unsupported file: not a PDF.');
  }
  const source = Buffer.from(buffer);
  const output: string[] = [];
  let currentLine = '';

  const flushLine = () => {
    const line = currentLine.replace(/\s+/g, ' ').trim();
    if (line) output.push(line);
    currentLine = '';
  };

  STREAM_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = STREAM_RE.exec(source.toString('latin1'))) !== null) {
    const rawBody = match[1];
    if (rawBody === undefined) continue;
    // Dictionnaire précédant ce flux (512 octets avant « stream »).
    const dictStart = Math.max(0, match.index - 512);
    const before = source.toString('latin1', dictStart, match.index);
    if (!/\/FlateDecode/.test(before)) {
      continue; // Flux non compressé Flate : ignoré (V1, prudent).
    }
    let decoded: Buffer;
    try {
      decoded = inflateSync(Buffer.from(rawBody, 'latin1'));
    } catch {
      continue; // Flux corrompu/partiel : ignoré silencieusement.
    }
    const content = decoded.toString('latin1');

    // Découpage en opérateurs texte simples (Tj / TJ / Td / TD / T* / ET).
    // `Td`/`TD`/`T*` marquent un retour à la ligne ; `ET` ferme l'objet texte.
    const tokenRe =
      /\(((?:[^()\\]|\\.)*)\)\s*Tj|\[([^\]]*)\]\s*TJ|\bTd\b|\bTD\b|T\*|ET/g;
    let token: RegExpExecArray | null;
    while ((token = tokenRe.exec(content)) !== null) {
      if (token[3] === undefined && token[1] === undefined && token[2] === undefined) {
        // Opérateur seul : Td / TD / T* / ET → fin de ligne logique.
        flushLine();
        continue;
      }
      const append = (text: string) => {
        if (currentLine !== '' && !currentLine.endsWith(' ')) {
          currentLine += ' ';
        }
        currentLine += text;
      };
      if (token[1] !== undefined) {
        append(decodePdfString(token[1]));
        continue;
      }
      if (token[2] !== undefined) {
        const parts = token[2].match(/\(((?:[^()\\]|\\.)*)\)/g);
        if (parts) {
          for (const part of parts) {
            append(decodePdfString(part.slice(1, -1)));
          }
        }
      }
    }
    flushLine();
  }

  return output.join('\n');
}
