// calibration.js
// Fonctions PURES de calibration et de calcul — aucune dépendance à React
// ou aux capteurs. Elles prennent des tableaux d'échantillons {x, y, z} et
// renvoient un résultat. Isolées ici pour pouvoir facilement améliorer la
// stratégie de calibration et la TESTER en Node (voir le plan de test).
//
// Améliorations clés :
//  - Biais par MÉDIANE (robuste : un échantillon aberrant ne fausse rien)
//  - Axe de rotation sous forme de VECTEUR UNITAIRE (pas juste un axe)
//  - Vitesse par MAGNITUDE du vecteur gyro : la vraie vitesse de rotation
//    quelle que soit l'inclinaison du téléphone sur la platine. Avec la
//    méthode "1 seul axe", un téléphone incliné lisait ~70% de la vitesse
//    réelle (jamais 33 RPM) !

/**
 * Moyenne d'un tableau d'échantillons {x, y, z}.
 */
export function averageSamples(samples) {
  if (samples.length === 0) return { x: 0, y: 0, z: 0 };

  const sum = samples.reduce(
    (acc, s) => ({ x: acc.x + s.x, y: acc.y + s.y, z: acc.z + s.z }),
    { x: 0, y: 0, z: 0 }
  );

  return {
    x: sum.x / samples.length,
    y: sum.y / samples.length,
    z: sum.z / samples.length,
  };
}

/**
 * Calibration du biais (offset) du gyroscope — téléphone IMMOBILE.
 * Médiane par axe plutôt que moyenne : robuste si le téléphone a bougé ou
 * vibré un court instant pendant la calibration (un outlier n'écrase pas
 * le résultat).
 */
export function computeBias(samples) {
  if (samples.length === 0) return { x: 0, y: 0, z: 0 };

  const median = (arr) => {
    arr.sort((a, b) => a - b);
    const mid = Math.floor(arr.length / 2);
    return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
  };

  return {
    x: median(samples.map((s) => s.x)),
    y: median(samples.map((s) => s.y)),
    z: median(samples.map((s) => s.z)),
  };
}

/**
 * Norme (magnitude) d'un vecteur d'échantillon.
 */
export function computeMagnitude(s) {
  return Math.sqrt(s.x * s.x + s.y * s.y + s.z * s.z);
}

/**
 * Détection de l'axe de rotation à partir d'échantillons capturés PENDANT
 * la rotation (biais déjà soustrait). La moyenne des vitesses angulaires
 * pointe le long de l'axe de rotation, peu importe l'inclinaison du
 * téléphone.
 *
 * Renvoie :
 *  - vector : vecteur UNITAIRE de l'axe (signe inclus : il pointe dans le
 *    sens de la rotation utilisée pendant la calibration = sens "avant")
 *  - label  : composante dominante ('X'|'Y'|'Z') pour l'affichage
 *  - valid  : false si la rotation était trop faible/nulle (à re-tester)
 */
export function detectRotationAxis(samples) {
  const avg = averageSamples(samples);
  const norm = computeMagnitude(avg);

  if (norm < 0.05) {
    // Pas assez de rotation pendant la fenêtre -> on ne peut pas deviner l'axe
    return { vector: { x: 0, y: 0, z: 0 }, label: null, valid: false };
  }

  const vector = { x: avg.x / norm, y: avg.y / norm, z: avg.z / norm };

  const ax = Math.abs(vector.x);
  const ay = Math.abs(vector.y);
  const az = Math.abs(vector.z);
  let label = 'Z';
  if (ax >= ay && ax >= az) label = 'X';
  else if (ay >= ax && ay >= az) label = 'Y';

  return { vector, label, valid: true };
}

// --- Lissage du MODULE de vitesse, robuste au bruit ---
// Le problème observé sur le terrain : le signal brut du gyro oscille de
// ±10-13 RPM autour de la vitesse réelle. Un seuil de "saut" fixe et bas
// (3 RPM) était déclenché en permanence par ce bruit -> aucun lissage.
//
// Solution :
//  1. On estime le BRUIT en continu (erreur |brut - lissé| moyennée).
//  2. Le seuil de "vrai saut" s'adapte au bruit (2x le bruit, borné).
//  3. Un vrai saut (scratch, arrêt, accélération franche) bascule en mode
//     rapide pendant quelques échantillons, puis revient en mode lent.
//
// La DIRECTION (avant/arrière) n'est PAS lissée : elle est instantanée
// (signe du produit scalaire), donc backspin et scratch réagissent en
// moins de 30ms même quand le module est fortement lissé.

// Lissage FORT : la direction étant traitée séparément (instantanée), le
// module peut être lissé très fortement sans perdre le backspin/scratch.
// Constante de temps ~3 s -> le ratio envoyé au Pi est quasi constant en
// rotation stable, plus d'à-coups de pitch.
export const EMA_ALPHA_SLOW = 0.01;
const EMA_ALPHA_FAST = 0.25;         // rattrapage rapide (vraies grosses variations)
const NOISE_ALPHA = 0.05;            // estimation du bruit (moyenne glissante)
const BIG_JUMP_FACTOR = 3.0;         // un saut = 3x le bruit estimé
const MIN_BIG_JUMP = 30;             // seuil minimum (RPM) : bien au-dessus du bruit
const MAX_BIG_JUMP = 45;             // seuil maximum (RPM)
const FAST_HOLD_PER_RPM = 1;         // nb d'échantillons rapides par RPM d'écart
const FAST_HOLD_MAX = 15;            // plafond du maintien rapide (~0,5 s)

/**
 * Lisseur de RPM testable (état porté par l'objet).
 *   - update(instantRpm) -> RPM lissé
 *   - snapTo(value)      -> force la valeur (ex: 0 à l'arrêt brutal)
 *   - reset()            -> repart de zéro (nouvelle mesure)
 */
export function createSmoother() {
  return {
    ema: null,
    noise: null,
    fastHold: 0,

    update(instantRpm) {
      const prev = this.ema ?? 0;
      const error = Math.abs(instantRpm - prev);
      this.noise =
        this.noise === null ? error : NOISE_ALPHA * error + (1 - NOISE_ALPHA) * this.noise;

      const threshold = Math.min(
        MAX_BIG_JUMP,
        Math.max(MIN_BIG_JUMP, this.noise * BIG_JUMP_FACTOR)
      );
      if (error > threshold) {
        this.fastHold = Math.min(
          FAST_HOLD_MAX,
          Math.ceil(error * FAST_HOLD_PER_RPM)
        );
      }

      const alpha = this.fastHold > 0 ? EMA_ALPHA_FAST : EMA_ALPHA_SLOW;
      if (this.fastHold > 0) this.fastHold -= 1;

      this.ema = this.ema === null ? instantRpm : alpha * instantRpm + (1 - alpha) * this.ema;
      return this.ema;
    },

    snapTo(value) {
      this.ema = value;
      this.noise = 0;
      this.fastHold = 0;
    },

    reset() {
      this.ema = null;
      this.noise = null;
      this.fastHold = 0;
    },
  };
}

// --- Vitesses standard (vinyle) ---
export const STANDARD_SPEEDS = [33.33, 45, 78];

/**
 * Renvoie la vitesse standard la plus proche (pour le recalage automatique).
 */
export function closestStandard(value) {
  return STANDARD_SPEEDS.reduce((closest, s) =>
    Math.abs(s - value) < Math.abs(closest - value) ? s : closest
  );
}

// --- Recalage automatique du GAIN (corrige le sous-comptage du gyro) ---
// Le gyro sous-estime légèrement la vitesse (rocking résiduel, échelle du
// capteur) : on voit souvent 31-32 au lieu de 33.3. Ce gain se corrige tout
// seul, lentement, vers la vitesse standard la plus proche — MAIS seulement
// si on en est proche (bande ±6%) : un décalage volontaire du DJ (ex: 30 ou
// 36 RPM) n'est PAS écrasé.
const GAIN_MIN = 0.88;
const GAIN_MAX = 1.12;
const GAIN_BAND = 0.06; // ±6% autour de la vitesse standard

export function autoCorrectGain(gain, speedRpm, alpha = 0.008) {
  const s = Math.abs(speedRpm);
  if (s < 10) return gain; // pas à l'arrêt
  const target = closestStandard(s);
  if (Math.abs(s - target) > target * GAIN_BAND) {
    // Hors bande : on ne corrige PAS vers la standard (respect du pitch
    // volontaire du DJ), MAIS si le gain s'est écarté de 1 (ex: gain
    // instantané erroné de la détection d'axe), on le ramène doucement
    // vers 1 -> une erreur ne peut jamais rester verrouillée.
    if (Math.abs(gain - 1) > 0.01) {
      return gain > 1 ? Math.max(1, gain - alpha * 0.5) : Math.min(1, gain + alpha * 0.5);
    }
    return gain;
  }
  const corrected = s * gain;
  return Math.min(GAIN_MAX, Math.max(GAIN_MIN, gain + alpha * (target - corrected) / target));
}

// --- Gain INSTANTANÉ à partir des échantillons de la détection d'axe ---
// Pendant la détection d'axe (~1,5 s), le téléphone tourne déjà sur la
// platine. On connaît donc la vitesse mesurée AVANT de commencer la mesure :
// si elle est proche d'une vitesse standard, on en déduit immédiatement le
// facteur d'échelle du gyro (standard / mesuré). L'utilisateur voit ~33.3
// dès la première seconde, au lieu d'attendre les ~20 s du recalage lent.
//
// Robustesse :
//  - percentile 30 des magnitudes (la montée en vitesse et le "rocking"
//    gonflent la norme -> on reste sous la valeur, jamais au-dessus)
//  - bande ±15% : une vitesse non standard (rampe, tenue à la main à 20 RPM)
//    ne calibre RIEN -> le recalage lent prend le relais.
export const AXIS_GAIN_MIN = 0.9;
export const AXIS_GAIN_MAX = 1.15;
// Bande ±15% : assez large pour accepter le cas réel (gyro qui lit 31.5 pour
// une platine à 33.33, avec le bruit du capteur) et rejeter les vitesses non
// standards (rampe, tenue à la main à 20 RPM). Un gain erroné n'est pas
// verrouillé : autoCorrectGain le ramène vers 1 s'il sort de sa propre bande.
export const AXIS_GAIN_BAND = 0.15; // ±15% autour d'une vitesse standard

export function estimateGainFromSamples(samples, { band = AXIS_GAIN_BAND } = {}) {
  if (samples.length < 4) return 1; // pas assez d'échantillons
  const mags = samples.map(computeMagnitude).sort((a, b) => a - b);
  const p30 = mags[Math.min(mags.length - 1, Math.floor(mags.length * 0.3))];
  const rpm = p30 * (60 / (2 * Math.PI));
  if (rpm < 10) return 1; // pas en rotation
  const target = closestStandard(rpm);
  const ratio = rpm / target;
  if (Math.abs(ratio - 1) > band) return 1; // vitesse non standard : on ne calibre pas
  return Math.min(AXIS_GAIN_MAX, Math.max(AXIS_GAIN_MIN, 1 / ratio));
}

/**
 * Détection du RELÂCHEMENT de la platine (partie pure/statique).
 *
 * Quand le DJ lâche le plateau (après un backspin ou un arrêt à la main),
 * la platine revient d'elle-même à sa vitesse standard (33.33/45). Au lieu
 * de laisser le lissage remonter lentement, on détecte ce moment pour
 * s'accrocher DIRECTEMENT à la vitesse standard (pas de temps perdu).
 *
 * Retourne deux indicateurs ; le hook maintient un compteur pour exiger un
 * état "away" SOUTENU (~300 ms) et ne déclenche qu'au passage dans la bande :
 *  - rawAway : la vitesse LISSÉE est loin d'une standard (arrêt, tenue à la
 *    main hors bande...). Robust au bruit : une platine qui tourne stable
 *    garde sa valeur lissée dans la bande.
 *  - near    : la vitesse BRUTE est entrée dans la bande d'une standard
 *    (la platine relâchée revient d'elle-même).
 *
 * @param smoothedRpm vitesse lissée (état global)
 * @param rawRpm      vitesse brute (moment du passage dans la bande)
 */
export function detectRelease(smoothedRpm, rawRpm, band = GAIN_BAND) {
  const s = Math.abs(smoothedRpm);
  const std = closestStandard(s);
  const rawAway = s <= 15 || Math.abs(s - std) > std * band;

  const raw = Math.abs(rawRpm);
  const rawStd = closestStandard(raw);
  const near = raw > 15 && Math.abs(raw - rawStd) <= rawStd * band;

  return { near, rawAway };
}

// --- Ré-accrochage après arrêt : il faut un VRAI geste ---
// Le ré-accrochage (relock) après un arrêt se déclenche quand la platine
// repart. Avant, n'importe quel petit mouvement (absSpeed > 1 rad/s ≈
// 9,5 RPM) recollait la valeur instantanément -> affichage de ±17 RPM en
// bougeant à peine. Désormais il faut une vitesse SOUTENUE élevée
// (3 rad/s ≈ 28,6 RPM, un vrai scratch/sec) pendant plusieurs échantillons
// consécutifs.
export const RELOCK_MIN_RAD_S = 3.0; // ~28,6 RPM : en dessous, on ne ré-accroche pas
export const RELOCK_CONSECUTIVE = 3; // 3 échantillons consécutifs au-dessus du seuil
// Sous cette vitesse (~9,5 RPM) on considère la platine comme (quasi) à
// l'arrêt : on recolle à 0 et on attend un vrai geste pour repartir.
export const STOPPED_RAD_S = 1.0;

/**
 * Fonction pure du compteur de ré-accrochage : incrémente quand la vitesse
 * dépasse le seuil, remet à 0 sinon. Le hook ré-accroche quand le compteur
 * atteint RELOCK_CONSECUTIVE.
 */
export function relockStep(count, absSpeedRadS) {
  return absSpeedRadS >= RELOCK_MIN_RAD_S ? count + 1 : 0;
}

// Zone morte : en dessous de cette vitesse angulaire (rad/s) on considère
// que la platine est à l'arrêt -> direction 0 et RPM nul.
// (Un peu large : la magnitude du vecteur gyro au repos = sqrt(3) x le
// bruit d'un seul axe.)
export const ZERO_DEADBAND_RAD_S = 0.2;

// Durées par défaut des phases de calibration (ms). Regroupées ici pour
// être facilement ajustables sans fouiller dans la logique du hook.
export const CALIBRATION_TIMINGS = {
  BIAS_CALIBRATION_MS: 3000, // 3 s téléphone immobile : biais robuste
  AXIS_CALIBRATION_MS: 1500, // 1,5 s en rotation : axe fiable
};
