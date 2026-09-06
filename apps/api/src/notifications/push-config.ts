/**
 * Configuration Web Push (étape 12).
 *
 * Clés VAPID lues depuis l'environnement. La clé PRIVÉE n'est jamais
 * commitée, jamais exposée au frontend, jamais loggée. En local/test sans
 * clés, le Web Push est déclaré indisponible (`pushAvailable: false`) et le
 * centre de notifications interne continue de fonctionner : l'API ne plante
 * jamais faute de VAPID.
 */

export interface VapidConfig {
  publicKey: string | null;
  privateKey: string | null;
  /** Contact du responsable des abonnements (RFC 8030). */
  subject: string;
}

export function readVapidConfig(): VapidConfig {
  const publicKey = process.env.WEB_PUSH_VAPID_PUBLIC_KEY?.trim() || null;
  const privateKey = process.env.WEB_PUSH_VAPID_PRIVATE_KEY?.trim() || null;
  return {
    publicKey,
    privateKey,
    subject:
      process.env.WEB_PUSH_VAPID_SUBJECT?.trim() ??
      'mailto:notifications@finance.local',
  };
}

/** Le protocole Web Push VAPID est-il utilisable ? */
export function isWebPushConfigured(): boolean {
  const config = readVapidConfig();
  return Boolean(config.publicKey && config.privateKey);
}

/** Configuration PUBLIQUE retournée au frontend (jamais la clé privée). */
export function publicPushConfig(): {
  pushAvailable: boolean;
  publicKey: string | null;
} {
  return {
    pushAvailable: isWebPushConfigured(),
    publicKey: readVapidConfig().publicKey,
  };
}
