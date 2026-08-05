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

// --- Estimateur de PHASE (intégrale de la vitesse angulaire) ---
// C'est le vrai remède "stabilité + sensibilité au pitch" : au lieu de lisser
// chaque échantillon (EMA, qui laisse passer le bruit ou traîne trop), on
// INTÈGRE la vitesse axiale signée et on lit la pente sur une fenêtre
// glissante. Le bruit de mesure (rocking du téléphone, pics) est
// zéro-moyenne : il s'annule dans l'intégrale, alors qu'un vrai changement
// de pitch déplace la pente et est suivi. Les snaps (arrêt, relock,
// relâchement) ré-ensemencent la fenêtre -> réponse immédiate préservée.
// Fenêtre de l'estimateur : LONGUE en rotation stable, RAPIDE (500 ms) juste
// après un snap (relock, arrêt, relâchement) pour que la valeur affichée
// rejoigne la vraie vitesse en ~0,55 s au lieu de ~2 s. Le hook appelle
// setWindow(FAST) sur un événement, puis revient à LONG après
// ESTIMATOR_FAST_HOLD_MS.
//
// ⚠️ POURQUOI 5 s (et pas 3,5 s) ? Le rocking réel oscille autour de ~0,4 Hz
// (période ~2,5 s). L'intégrale d'un sinus sur un nombre ENTIER de périodes
// s'annule parfaitement, quelle que soit la phase : avec 5 s = 2 périodes
// exactes, le mode dominant du wobble (±37% dans les logs terrain) est
// annulé à ~0,000 RPM au lieu de laisser ±4,5 RPM à 3,5 s (1,4 période).
// Le pitch (changement de la pente, lent) reste suivi, et les gestes sont
// gérés par les snaps + le lisseur de sortie (createStableOutput).
export const ESTIMATOR_WINDOW_MS = 5000;
export const ESTIMATOR_FAST_WINDOW_MS = 500;
export const ESTIMATOR_FAST_HOLD_MS = 700;

// --- Lisseur de SORTIE (stabilité de fou sur Rekordbox) ---
// L'estimateur de phase élimine le wobble, mais il reste un résidu de bruit
// sur la valeur envoyée au Pi : à 0 de pitch, Rekordbox afficherait un pitch
// qui tremble. createStableOutput est un lisseur "freeze & catch-up" appliqué
// à la valeur FINALE envoyée (rpmRef). Il distingue le bruit (qui oscille,
// change de signe en permanence) d'un vrai changement (qui persiste) :
//  - Tant que l'écart (entrée - sortie) reste sous STABLE_DEADBAND_RPM ET
//    change de signe régulièrement, la sortie est FIGÉE : le ratio envoyé
//    est CONSTANT en rotation stable (Rekordbox figé à 0,0% de pitch).
//  - Si l'écart dépasse la bande (pitch réel, relâchement, geste) OU si la
//    dérive reste du même signe pendant STABLE_PERSIST_MS (un pitch lent qui
//    s'installe, même petit), la sortie rattrape à STABLE_CATCHUP_ALPHA
//    (~30-100 ms) -> aucun retard perceptible.
//  - snapTo() force la sortie instantanément (arrêt, relock, motion snap,
//    relâchement) : le scratch et le redémarrage restent au ms.
// En clair : la valeur envoyée est CONSTANTE en rotation stable (au lieu de
// trembler de ±0,5 RPM), et suit la main immédiatement pendant un geste.
export const STABLE_DEADBAND_RPM = 0.7;  // bruit max toléré : en dessous, on ne bouge pas
// (0,7 RPM ≈ le résidu max de l'estimateur sur le wobble terrain ±37% après
// la fenêtre 5 s ; au-dessus, c'est forcément un vrai changement de vitesse)
export const STABLE_CATCHUP_ALPHA = 0.3; // rattrapage rapide : ~30 ms à 100 Hz
export const STABLE_FINISH_ALPHA = 0.05; // fin de convergence après un gros écart
// (évite de geler à 0,5 RPM sous la cible : après un pitch, on continue de
// converger doucement pendant ~200 ms au lieu de s'arrêter net à la bande)
export const STABLE_FINISH_SAMPLES = 20; // durée de la finition après un gros écart
export const STABLE_DRIFT_ALPHA = 0.002; // dérive LENTE dans la bande (corrige un offset résiduel)
// (si le wobble résiduel est centré à +0,3 RPM de la sortie figée, l'écart
// change de signe en permanence -> la persistance ne s'arme jamais et la
// sortie resterait gelée sur un offset permanent de ~0,3-0,6 RPM. Ce drift
// minuscule ramène la sortie vers la moyenne de l'entrée en ~5 s, avec un
// mouvement invisible de ~0,03 RPM/s -> la stabilité de fou est conservée.)
export const STABLE_PERSIST_MS = 500;    // dérive unidirectionnelle requise pour un vrai changement lent
// (un pitch qui s'installe produit un écart constant du même signe pendant
// des secondes ; le wobble résiduel de l'estimateur, lui, change de signe
// toutes les ~300 ms max -> jamais de fausse détection en rotation stable)

export function createStableOutput({ sampleMs = 10 } = {}) {
  let out = null;
  let sameSign = 0;   // échantillons consécutifs dans le même sens (dérive)
  let lastSign = 0;
  let finishLeft = 0; // échantillons de finition restants après un gros écart
  const persistN = Math.max(2, Math.ceil(STABLE_PERSIST_MS / sampleMs));
  return {
    /** @param vRpm valeur SIGNÉE (RPM) à lisser @returns la sortie lissée */
    update(vRpm) {
      if (out === null) {
        out = vRpm;
        return out;
      }
      const gap = vRpm - out;
      const sign = gap > 0 ? 1 : gap < 0 ? -1 : 0;
      sameSign = sign === lastSign && sign !== 0 ? sameSign + 1 : sign === 0 ? 0 : 1;
      lastSign = sign;
      const big = Math.abs(gap) > STABLE_DEADBAND_RPM;
      const persistent = sameSign >= persistN; // vrai changement lent installé
      if (big) finishLeft = STABLE_FINISH_SAMPLES; // un gros écart arme la finition
      let alpha = 0;
      if (big || persistent) alpha = STABLE_CATCHUP_ALPHA;
      else if (finishLeft > 0) alpha = STABLE_FINISH_ALPHA; // finition : ne pas geler sous la cible
      else alpha = STABLE_DRIFT_ALPHA; // dérive lente : referme tout offset résiduel
      if (finishLeft > 0) finishLeft -= 1;
      out += alpha * gap;
      return out;
    },
    /** Force la sortie immédiatement (arrêt, relock, motion snap...) */
    snapTo(vRpm) {
      out = vRpm;
      sameSign = 0;
      lastSign = 0;
      finishLeft = 0;
    },
    reset() {
      out = null;
      sameSign = 0;
      lastSign = 0;
      finishLeft = 0;
    },
  };
}

// Snap d'ARRÊT ANTICIPÉ (décélération douce) : si la vitesse BRUTE tombe à plus
// de ce seuil SOUS l'estimé lissé (pendant ~100 ms), la platine décélère -> on
// colle l'estimé au suivi rapide pour que l'affichage suive la décélération en
// temps réel. Le wobble du rocking (écart max mesuré ~15,5 RPM avec bruit ±37%)
// reste SOUS 20 : aucun faux déclenchement en rotation stable.
export const SLOW_STOP_GAP_RPM = 20;
export const SLOW_STOP_MS = 200;
// Durée SOUTENUE de l'écart requise pour le snap d'arrêt anticipé. Portée à
// 200 ms : un creux transitoire du wobble (60-120 ms) ne déclenche plus le
// snap (sinon pic de ralentissement envoyé au Pi), alors qu'un vrai freinage
// de la platine maintient l'écart > 20 pendant des centaines de ms.

export function createPhaseEstimator({ windowMs = ESTIMATOR_WINDOW_MS, sampleMs = 50 } = {}) {
  const RAD2RPM = 60 / (2 * Math.PI);
  let totalAngle = 0; // intégrale signée de la vitesse axiale (rad)
  let lastT = null;   // dernier timestamp -> dt RÉEL (pas supposé)
  let win = windowMs; // fenêtre courante (changeable via setWindow)
  const buf = [];     // fenêtre glissante : [{ t, angle }]
  return {
    /** @param dotRadS vitesse axiale SIGNÉE (rad/s) @param now ms */
    update(dotRadS, now) {
      // dt réel entre les échantillons : l'intégrale reste juste même si le
      // gyro délivre à une cadence un peu différente de 50 ms (jitter, fusion
      // d'échantillons). Borné à 5 échantillons : une longue pause (app en
      // arrière-plan) ne doit pas intégrer des données périmées.
      if (lastT === null) lastT = now;
      const elapsed = Math.max(0, Math.min(now - lastT, sampleMs * 5));
      lastT = now;
      totalAngle += dotRadS * (elapsed / 1000);
      buf.push({ t: now, angle: totalAngle });
      const cutoff = now - win;
      // On n'avance le bord gauche QUE si le suivant est lui-même hors
      // fenêtre : un bord VIRTUEL posé par snapTo survit donc jusqu'à ce que
      // de vraies données aient rempli la fenêtre (pas d'effondrement à 50 ms
      // juste après un arrêt/relock/relâchement).
      while (buf.length > 2 && buf[1].t <= cutoff) buf.shift();
      if (buf.length < 2) return 0;
      const dt = (buf[buf.length - 1].t - buf[0].t) / 1000;
      if (dt <= 0) return 0;
      return ((totalAngle - buf[0].angle) / dt) * RAD2RPM;
    },
    // Force la sortie immédiate à `rpm` : on pose un bord gauche VIRTUEL qui
    // implique que la vitesse valait `rpm` pendant toute la fenêtre passée.
    snapTo(rpm, now) {
      const velocity = rpm / RAD2RPM; // rad/s
      totalAngle = 0;
      lastT = now;
      buf.length = 0;
      buf.push({ t: now - win, angle: -velocity * (win / 1000) });
    },
    // Fenêtre adaptative : RAPIDE juste après un événement (relock/arrêt/…),
    // puis retour à la fenêtre longue pour la stabilité.
    setWindow(ms) {
      win = Math.max(100, ms);
    },
    getWindow() {
      return win;
    },
    reset() {
      totalAngle = 0;
      lastT = null;
      win = windowMs;
      buf.length = 0;
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
// Bande étroite ±2% : le recalage lent ne doit corriger QUE la dérive
// résiduelle quand la platine est (quasi) pile sur une vitesse standard.
// Un pitch volontaire du DJ (>= ~2-3%) n'est JAMAIS effacé (sensibilité
// au pitch). Le facteur d'échelle du gyro, lui, est réglé instantanément
// par estimateGainFromSamples pendant la détection d'axe.
const GAIN_BAND = 0.02; // ±2% autour de la vitesse standard
// Le recalage lent teste la bande sur la vitesse CORRIGÉE (brut × gain) et
// non sur le brut : sinon un gain de calibrage légitime (ex: 1.028 pour un
// gyro qui lit 2,8% bas) serait jugé « hors bande » et ramené vers 1 par
// l'anti-verrou — c'était LE bug : le gain instantané était posé puis détruit
// en quelques secondes (vu en vrai : gain coincé à 1.009, RPM à 32.7).
// Toujours clampé dans [GAIN_MIN, GAIN_MAX] pour ne jamais partir en vrille.
export function autoCorrectGain(gain, speedRpm, alpha = 0.02) {
  const s = Math.abs(speedRpm);
  if (s < 10) return gain; // pas à l'arrêt
  const target = closestStandard(s);
  const corrected = s * gain;
  const inBand = Math.abs(corrected - target) <= target * GAIN_BAND;
  // Anti-verrou : un gain VRAIMENT loin de 1 (ex: mauvaise calib d'axe
  // posant 1.11) est ramené doucement vers 1 — MÊME si la vitesse corrigée
  // tombe dans la bande (sinon 30×1.11≈33.3 serait verrouillé à vie).
  // Un gain de calibrage légitime (≤ ~5%) survit TOUJOURS : hors bande à
  // cause d'un PITCH volontaire (ex: 34.5 → corrigé 35.5), on ne le dissout
  // jamais, sinon la compensation d'échelle serait érodée et le pitch affiché
  // dériverait vers le brut (c'était le point bloquant de la review).
  // ⚠️ Note : seuil 0.05 plus strict que AXIS_GAIN_BAND (0.06) → un capteur
  // à erreur d'échelle 5-5,5% voit son gain légitime (~1.058) décroître à
  // ~1.05 puis la correction douce le repousse : petite oscillation bornée,
  // affichage ~0,5% bas — auto-limitée, acceptable. C'est le prix du pitch
  // parfaitement respecté.
  if (Math.abs(gain - 1) > 0.05) {
    const next = gain > 1 ? gain - alpha * 0.25 : gain + alpha * 0.25;
    return Math.min(GAIN_MAX, Math.max(GAIN_MIN, next));
  }
  if (!inBand) return gain; // pitch volontaire du DJ : gain légitime intact
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
// Bande ±6% : couvre le facteur d'échelle typique du gyro (~5%) avec une
// petite marge, rejette les vitesses non standards (rampe, 20 RPM à la main)
// et préserve un pitch volontaire au-delà de ~6-7%. Un gain erroné n'est pas
// verrouillé : autoCorrectGain le ramène vers 1 s'il sort de sa bande.
// ⚠️ À calibrer avec le pitch de la platine à ZÉRO (sinon le pitch est
// intégré au facteur d'échelle et affiché comme 33.33).
export const AXIS_GAIN_BAND = 0.06; // ±6% autour d'une vitesse standard

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
// Bande de DÉTECTION du relâchement (indépendante du gain) : la platine
// relâchée revient d'elle-même dans ~±6% de sa standard -> on s'y accroche.
export const RELEASE_BAND = 0.06;

export function detectRelease(smoothedRpm, rawRpm, band = RELEASE_BAND, target = null) {
  // target = vitesse standard choisie dans l'UI (33/45/78) : sans elle, on
  // tomberait dans la bande d'une AUTRE standard (ex: un 33 bruyant qui monte
  // à 43 déclencherait un faux relâchement vers 45).
  const s = Math.abs(smoothedRpm);
  const std = target ?? closestStandard(s);
  const rawAway = s <= 15 || Math.abs(s - std) > std * band;

  const raw = Math.abs(rawRpm);
  const rawStd = target ?? closestStandard(raw);
  const near = raw > 15 && Math.abs(raw - rawStd) <= rawStd * band;

  return { near, rawAway };
}

// --- Suivi de la main pendant un VRAI geste (motion snap) ---
// La fenêtre d'intégration (3,5 s) stabilise la magnitude mais TRAÎNE ~2 s
// derrière un changement franc de vitesse (scratch, backspin, poussée à la
// main) : le DJ entend le son "suivre" en retard. Si la vitesse BRUTE
// s'écarte de l'estimé fenêtré de plus de ce seuil, c'est un geste réel :
// le hook colle l'estimateur au suivi rapide pour que la magnitude suive la
// main en ~50-100 ms au lieu de ~2 s.
// Le wobble du rocking (déviation max ~±12 RPM sur les logs réels, pics à
// ~15 avec l'harmonique 1,7 Hz) ne peut PAS franchir 20 RPM -> aucune fausse
// détection en rotation stable, ET un geste MODÉRÉ (poussée à ~54 RPM,
// décélération franche) franchit le seuil et suit la main immédiatement.
export const MOTION_SNAP_RPM = 20;
// Le snap exige une PERSISTANCE pour les déviations MÊME-SIGNE : 12 échantillons
// (120 ms à 100 Hz). Un creux transitoire du wobble (le raw plonge brièvement
// à 8-12 RPM, dure 60-120 ms) ne doit PAS injecter le creux dans la sortie
// lissée (faux snap -> pic de ralentissement envoyé au Pi). Un vrai geste
// (poussée, freinage) dure des centaines de ms -> toujours déclenché.
// Les FLIPS (passage au signe opposé = scratch/backspin réel) snappent en 2
// échantillons : la main traverse le zéro, il n'y a aucune ambiguïté avec un
// creux de wobble (qui, lui, garde le signe de la rotation). UNE CONDITION :
// la magnitude doit dépasser MOTION_SNAP_FLIP_MIN_RPM (~19 RPM). Un creux du
// wobble qui franchirait brièvement zéro (axe mal calibré, rocking violent)
// reste de petite magnitude (< 19) -> pas un vrai flip -> pas de pic négatif
// envoyé. Un vrai scratch/backspin repart toujours à ±20-33 RPM.
export const MOTION_SNAP_CONSECUTIVE = 12;  // persistance déviation même-signe (120 ms)
export const MOTION_SNAP_FLIP_CONSECUTIVE = 2; // flip (signe opposé) : snap immédiat (20 ms)
export const MOTION_SNAP_FLIP_MIN_RPM = 19; // magnitude minimale d'un vrai flip (~19 RPM)
// RE-SNAP : quand on est déjà en fenêtre RAPIDE (juste après un snap), on
// continue de suivre la main avec un seuil réduit et 2 échantillons. C'est ce
// qui permet au scratch de suivre les flips successifs et à la sortie de
// remonter vite quand la main relâche (retour à 33 immédiat). Le seuil réduit
// (16) reste AU-DESSUS du wobble résiduel (déviation max mesurée ~15,5 avec
// l'harmonique 1,7 Hz) : pas de faux re-snap en rotation stable, mais un retour
// de geste (écart > 30-50) rattrape tout de suite.
export const MOTION_SNAP_RESNAP_RPM = 16;
export const MOTION_SNAP_RESNAP_CONSECUTIVE = 2;

// --- Ré-accrochage après arrêt : il faut un VRAI geste ---
// Le ré-accrochage (relock) après un arrêt se déclenche quand la platine
// repart. Avant, n'importe quel petit mouvement (absSpeed > 1 rad/s ≈
// 9,5 RPM) recollait la valeur instantanément -> affichage de ±17 RPM en
// bougeant à peine. Désormais il faut une vitesse SOUTENUE élevée
// (3 rad/s ≈ 28,6 RPM, un vrai scratch/sec) pendant plusieurs échantillons
// consécutifs.
export const RELOCK_MIN_RAD_S = 2.0; // ~19,1 RPM : en dessous, on ne ré-accroche pas
// (2.0 rad/s au lieu de 3.0 : un backspin/scratch MOYEN (~20 RPM) ré-accroche
// lui aussi, pas seulement les gestes violents. Un petit geste du poignet
// (< 19 RPM) reste sous le seuil et ne déclenche rien.)
export const RELOCK_CONSECUTIVE = 5; // 5 échantillons consécutifs au-dessus du seuil
// (50 ms à 100 Hz : filtre les micro-gestes transitoires qui dépasseraient
// brièvement 19 RPM, tout en gardant un vrai backspin/scratch bien réactif.)
// Sous cette vitesse (~9,5 RPM) on considère la platine comme (quasi) à
// l'arrêt : on recolle à 0 et on attend un vrai geste pour repartir.
export const STOPPED_RAD_S = 1.0;
// Durée SOUTENUE sous STOPPED_RAD_S requise pour déclarer un arrêt doux.
// ⚠️ COMPROMIS PRIORISÉ : le BACKSPIN (la priorité du DJ : "backspine sans
// que ça coupe parce qu'on passe à 0"). Pendant un backspin, la vitesse
// traverse la zone < 9,5 RPM en passant par zéro. Un backspin MOYEN traverse
// en ~100-250 ms, un backspin LENT en ~300 ms. 350 ms couvre la quasi-totalité
// des gestes réels : dès que la vitesse repart au-dessus de 1,0 rad/s
// (l'échappatoire `else` du hook remet le chrono à zéro), ce n'était pas un
// arrêt -> le son ne coupe jamais pendant le backspin.
// Un VRAI arrêt, lui, reste sous le seuil pendant des centaines de ms à
// plusieurs secondes -> toujours déclaré (350 ms de délai sur un freinage
// doux est imperceptible : l'arrêt BRUTAL <10% en 100 ms gère les arrêts nets).
// Les flips de scratch (< 120 ms) restent aussi sans conséquence.
export const STOPPED_MS = 350;
// Fenêtre de NEUTRALISATION des arrêts pendant un BACKSPIN : quand le signe du
// produit scalaire s'inverse (la rotation passe avant -> arrière) pendant que
// la vitesse est encore notable, c'est un backspin qui traverse zéro — pas un
// arrêt. Pendant cette fenêtre, les détections d'arrêt (brutal, doux ET snap
// d'arrêt anticipé) sont ignorées : le son ne coupe JAMAIS pendant un
// backspin, même très lent.
// La garde se RÉ-ARME tant que la platine reste en mouvement dans le sens du
// backspin (un backspin long est protégé intégralement), et se LÈVE quand la
// platine redevient VRAIMENT immobile pendant BACKSPIN_CLEAR_MS : un arrêt
// réel juste après un backspin est alors détecté normalement (pas de latence
// résiduelle). Un vrai arrêt (platine qui décélère vers 0 sans changer de
// sens) n'arme jamais la garde.
export const BACKSPIN_GUARD_MS = 1000;
export const BACKSPIN_CLEAR_MS = 300; // immobilité requise pour lever la garde

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
