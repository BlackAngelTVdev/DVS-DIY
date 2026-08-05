// speedSender.js
// Envoie périodiquement le ratio de vitesse (RPM mesuré / RPM de référence)
// au serveur DVS Python via HTTP POST, au format attendu par son handler :
// un simple float en texte brut dans le corps de la requête.
// Exemple : ratio 1.0 = vitesse normale (33.33 RPM), 0.5 = deux fois plus
// lent, 1.5 = 50% plus rapide, etc.
//
// IMPORTANT : le serveur Python coupe le son si aucune requête n'arrive
// pendant 0.5s (voir "verifier_timeout_et_logs" côté serveur). On envoie
// donc à intervalle fixe, PAS seulement quand le RPM change, pour ne
// jamais dépasser ce délai même si la valeur est stable.
//
// Le ratio est SIGNÉ : négatif = platine en rotation arrière (backspin /
// scratch). Le serveur doit interpréter un ratio < 0 comme une lecture à
// reculons pour que le backspin fonctionne.

// ⚠️ À MODIFIER : mets l'IP réelle de ton Raspberry Pi sur le réseau local.
// (exportée : l'UI l'affiche aussi dans le debug)
export const SERVER_IP = '192.168.1.140';
const SERVER_PORT = 5005;
const REFERENCE_RPM = 33.33; // 1.0 = cette vitesse

export const SEND_INTERVAL_MS = 200; // 5 Hz : optimisé batterie (Wi-Fi radio), reste 2,5x sous le timeout 0,5 s
// Quand la platine est à l'arrêt, on n'a pas besoin de maintenir 5 Hz : un
// heartbeat toutes les 5 s suffit (le serveur ne coupe rien : la vitesse est
// déjà à 0 et il ne logue pas les timeouts à l'arrêt). Économie Wi-Fi majeure
// quand le téléphone reste posé sur une platine éteinte.
export const SLOW_INTERVAL_MS = 5000;

/**
 * Crée un "sender" qui interroge en continu la dernière valeur de RPM
 * (via getRpmValue, une fonction qui renvoie le RPM courant) et l'envoie
 * au serveur sous forme de ratio.
 *
 * Usage dans App.js :
 *   import { createSpeedSender } from './speedSender';
 *   const rpmRef = useRef(0);
 *   // ... à chaque mise à jour de rpm : rpmRef.current = nouvelleValeur;
 *   const sender = createSpeedSender(() => rpmRef.current);
 *   sender.start();
 *   // ...
 *   sender.stop();
 */
export function createSpeedSender(getRpmValue, options = {}) {
  const {
    ip = SERVER_IP,
    port = SERVER_PORT,
    referenceRpm = REFERENCE_RPM,
    intervalMs: initialInterval = SEND_INTERVAL_MS,
    onError = null, // callback optionnel (err) => void
    onSuccess = null, // callback optionnel (ratio) => void
  } = options;
  let intervalMs = initialInterval; // modifiable (cadence adaptative arrêt/rotation)

  const url = `http://${ip}:${port}/`;
  let intervalId = null;
  let sending = false; // garde anti-pile-up : pas de requêtes HTTP qui se chevauchent
  const FETCH_TIMEOUT_MS = 300; // au-delà, on abandonne (serveur injoignable) pour ne jamais bloquer l'envoi

  const sendOnce = async (overrideRpm) => {
    if (sending) return; // une requête est déjà en vol, on ignore ce tick
    sending = true;

    // overrideRpm permet d'envoyer une valeur ponctuelle forcée (ex: 0 à l'arrêt)
    const rpm = overrideRpm !== undefined ? overrideRpm : getRpmValue();
    const ratio = rpm / referenceRpm;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: ratio.toFixed(4),
        signal: controller.signal,
      });

      if (!response.ok) {
        console.log('[speedSender] Réponse serveur non-OK :', response.status);
        onError?.(new Error(`Réponse serveur ${response.status}`));
      } else {
        onSuccess?.(ratio);
      }
    } catch (err) {
      // Erreur réseau ou timeout (serveur injoignable, mauvaise IP, wifi coupé...)
      console.log('[speedSender] Échec envoi :', err.message || err);
      onError?.(err);
    } finally {
      clearTimeout(timer);
      sending = false;
    }
  };

  return {
    start() {
      if (intervalId !== null) return; // déjà démarré
      intervalId = setInterval(sendOnce, intervalMs);
    },
    stop() {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    },
    // Permet d'envoyer une valeur ponctuelle immédiatement (ex: pour tester)
    sendNow: sendOnce,
    // Cadence adaptative : réduit la radio au repos (5 s à l'arrêt) et
    // repasse en 200 ms dès que la platine tourne.
    setIntervalMs(ms) {
      intervalMs = ms;
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = setInterval(sendOnce, intervalMs);
      }
    },
  };
}