/**
 * Erreur applicative portant un statut HTTP.
 * Utilisée pour piloter les réponses d'erreur sans fuiter de détail interne.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
