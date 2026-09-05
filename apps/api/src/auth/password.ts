import argon2 from 'argon2';

/**
 * Hachage des mots de passe avec Argon2id (recommandé).
 * Aucun log, aucun stockage en clair : uniquement le hash vérifiable.
 */
export async function hashPassword(password: string): Promise<string> {
  // argon2.hash utilise Argon2id par défaut.
  return argon2.hash(password);
}

export async function verifyPassword(
  hash: string,
  password: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}
