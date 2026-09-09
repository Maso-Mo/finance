import { useSyncExternalStore } from 'react';
let unavailable = false;
const listeners = new Set<() => void>();
export function setUnavailable(value: boolean) {
  if (unavailable === value) return;
  unavailable = value; listeners.forEach(listener => listener());
}
export function isUnavailable() { return unavailable || !navigator.onLine; }
export function useUnavailable() {
  return useSyncExternalStore(listener => {
    listeners.add(listener);
    window.addEventListener('offline', listener); window.addEventListener('online', listener);
    return () => { listeners.delete(listener); window.removeEventListener('offline', listener); window.removeEventListener('online', listener); };
  }, isUnavailable);
}

export const OFFLINE_EMPTY_MESSAGE = 'Aucune donnée hors connexion disponible. Connecte-toi une première fois pour enregistrer tes données récentes sur cet appareil.';
