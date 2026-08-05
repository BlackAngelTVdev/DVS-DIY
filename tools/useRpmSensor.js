// useRpmSensor.js
// Hook qui encapsule toute la logique capteurs : gyroscope, accéléromètre,
// calibration (via calibration.js), calcul du RPM à partir de la vitesse
// angulaire INSTANTANÉE du gyroscope (signée : négatif = backspin/scratch
// arrière), et envoi HTTP (via speedSender.js).
//
// L'UI (RpmDisplay.js) ne fait qu'afficher ce que ce hook lui donne — elle
// ne connaît aucun détail de calcul.

import { useEffect, useRef, useState } from 'react';
import { Accelerometer, Gyroscope } from 'expo-sensors';
import {
  computeBias,
  computeMagnitude,
  detectRotationAxis,
  createPhaseEstimator,
  createStableOutput,
  autoCorrectGain,
  estimateGainFromSamples,
  detectRelease,
  relockStep,
  MOTION_SNAP_RPM,
  ESTIMATOR_WINDOW_MS,
  ESTIMATOR_FAST_WINDOW_MS,
  ESTIMATOR_FAST_HOLD_MS,
  SLOW_STOP_GAP_RPM,
  SLOW_STOP_MS,
  RELOCK_CONSECUTIVE,
  STOPPED_RAD_S,
  ZERO_DEADBAND_RAD_S,
  CALIBRATION_TIMINGS,
} from './calibration';
import { createSpeedSender, SEND_INTERVAL_MS, SLOW_INTERVAL_MS } from './speedSender';

const { BIAS_CALIBRATION_MS, AXIS_CALIBRATION_MS } = CALIBRATION_TIMINGS;

// --- Cadence des capteurs ---
// PENDANT la mesure : gyro à 100 Hz (10 ms) -> détections (arrêt, scratch,
// relock) quasi instantanées, ~5x plus rapides qu'avant. À L'ARRÊT : on
// repasse à 20 Hz (50 ms) pour économiser la batterie (le téléphone reste
// souvent posé sur une platine éteinte).
const SENSOR_UPDATE_INTERVAL_MS = 50;  // au repos / calibration biais
const SENSOR_FAST_INTERVAL_MS = 10;    // pendant la mesure (100 Hz)
const ACCEL_UPDATE_INTERVAL_MS = 100;
// Le state React (re-render de l'UI) n'a besoin que de ~12,5 fps pour un
// affichage de chiffres : on met à jour rpmRef (lu par le sender) à chaque
// échantillon, mais setRpm (qui déclenche le rendu) est limité à ce rythme.
const UI_UPDATE_INTERVAL_MS = 80;

// Rejet de choc/vibration : échantillon ignoré si l'accélération s'écarte
// trop de 1g (impact de la main, wobble du plateau...)
const ACCEL_SHOCK_THRESHOLD = 0.25; // en g


// --- Détection d'arrêt brutal ---
// Suivi RAPIDE (peu lissé) de la vitesse angulaire pour détecter une chute
// soudaine, indépendamment du lissage principal.
const STOP_DETECTION_FAST_ALPHA = 0.35;  // réactivité du suivi rapide
const STOP_DETECTION_RATIO = 0.10;       // chute sous 10% de la vitesse = arrêt
const STOP_DETECTION_MIN_RAD_S = 1.0;    // ne déclenche que si on tournait à ~9.5+ RPM


// Re-calibration continue du biais : quand le téléphone est immobile (platine
// à l'arrêt) pendant ~2 s, on réestime le biais et on le mélange doucement au
// biais actuel (compense la dérive du gyro avec la chaleur/temps).
const BIAS_REESTIMATE_RAW_MAG_MAX = 0.35; // rad/s : en dessous = immobile
const BIAS_REESTIMATE_MS = 2000;          // ~2 s d'immobilité
const BIAS_REESTIMATE_BLEND = 0.15;       // part du nouveau biais dans le mélange
// Durée "away" soutenue requise avant de considérer le relâchement (hystérésis)
const RELEASE_AWAY_MS = 300;              // ~300 ms hors bande
// Détection d'arrêt brutal : chute SOUTENUE sous 10% de la vitesse pendant
// ~100 ms. À 100 Hz c'est 10 échantillons : un passage à zéro d'un scratch
// (rapide, <100 ms) ne déclenche PAS un faux arrêt.
const STOP_DETECTION_MS = 100;

export function useRpmSensor() {
  const [phase, setPhase] = useState('idle'); // idle | calibratingBias | readyToSpin | calibratingAxis | measuring
  const [rpm, setRpm] = useState(0);
  const [rejectedCount, setRejectedCount] = useState(0);
  const [dominantAxisLabel, setDominantAxisLabel] = useState(null);
  const [biasInfo, setBiasInfo] = useState(null);
  const [sendStatus, setSendStatus] = useState('idle'); // idle | ok | error
  const [sensorError, setSensorError] = useState(null); // toute erreur capteur -> affichée à l'écran
  const [gain, setGain] = useState(1); // recalage auto (affiché dans l'UI)
  const [standardSpeed, setStandardSpeedState] = useState(33.33); // vitesse cible choisie (33/45/78)
  const [stability, setStability] = useState(0); // ± déviation récente du RPM lissé (affiché dans l'UI)

  const gyroSubRef = useRef(null);
  const accelSubRef = useRef(null);

  const lastAccelMagnitudeRef = useRef(1);

  const biasSamplesRef = useRef([]);
  const biasStartRef = useRef(null);
  const biasRef = useRef({ x: 0, y: 0, z: 0 });

  const axisSamplesRef = useRef([]);
  const axisStartRef = useRef(null);
  const axisVectorRef = useRef(null); // vecteur unitaire de l'axe calibré (null = pas encore détecté)

  const rejectedRef = useRef(0);
  const phaseRef = useRef(createPhaseEstimator()); // intègre la vitesse axiale (fenêtre 5 s)
  const stableOutRef = useRef(createStableOutput()); // lisseur de SORTIE (stabilité de fou)
  const gainRef = useRef(1);                    // recalage auto de la vitesse (vers 33/45/78)
  const releaseAwayRef = useRef(false);         // état "loin d'une standard" SOUTENU
  const releaseCountRef = useRef(0);            // compteur d'échantillons away consécutifs
  const releaseNearPrevRef = useRef(false);     // pour ne déclencher qu'à l'ENTRÉE dans la bande
  const releaseArmedRef = useRef(false);        // relâchement ARMÉ seulement après un VRAI arrêt
  const wasStoppedRef = useRef(true);           // pour ré-accrocher vite au redémarrage
  const relockCountRef = useRef(0);             // compteur du ré-accrochage (vrai geste requis)
  const lastUiUpdateRef = useRef(0);            // throttle des re-renders UI
  const restBiasSamplesRef = useRef([]);        // échantillons à l'arrêt -> re-calibration du biais
  const restBiasStartRef = useRef(null);        // instant du 1er échantillon d'immobilité (durée, pas comptage)
  const fastSpeedTrackerRef = useRef(null);     // suivi rapide pour détecter les arrêts brutaux
  const stopCandidateStartRef = useRef(null);   // instant du 1er échantillon sous le seuil d'arrêt
  const slowStopStartRef = useRef(null);        // instant du 1er échantillon sous l'écart d'arrêt anticipé
  const lastLogTimeRef = useRef(0);             // pour limiter la fréquence des logs
  const standardSpeedRef = useRef(33.33);       // miroir de standardSpeed pour le callback gyro
  const stabilityRingRef = useRef([]);          // dernières valeurs lissées -> déviation
  const cadenceRef = useRef('fast');            // cadence d'envoi (fast 30 ms / slow 5 s)
  const fastWindowUntilRef = useRef(0);         // fenêtre RAPIDE de l'estimateur jusqu'à ce timestamp

  const rpmRef = useRef(0); // toujours à jour, lu par le sender indépendamment du re-render

  const senderRef = useRef(null);
  if (senderRef.current === null) {
    // onSuccess/onError ne mettent à jour le state QUE si l'état change,
    // sinon chaque envoi (5 Hz) déclencherait un re-render inutile.
    senderRef.current = createSpeedSender(() => rpmRef.current, {
      onSuccess: () => setSendStatus((prev) => (prev === 'ok' ? prev : 'ok')),
      onError: () => setSendStatus((prev) => (prev === 'error' ? prev : 'error')),
    });
  }

  useEffect(() => {
    Gyroscope.setUpdateInterval(SENSOR_UPDATE_INTERVAL_MS);
    Accelerometer.setUpdateInterval(ACCEL_UPDATE_INTERVAL_MS);
    return () => {
      gyroSubRef.current?.remove();
      accelSubRef.current?.remove();
      senderRef.current.stop();
    };
  }, []);

  // Cadence du gyro : 100 Hz pendant la mesure (réactivité ms), 20 Hz sinon
  // (économie batterie quand le téléphone reste posé sur la platine éteinte).
  const setGyroRate = (fast) => {
    try {
      Gyroscope.setUpdateInterval(fast ? SENSOR_FAST_INTERVAL_MS : SENSOR_UPDATE_INTERVAL_MS);
    } catch (err) {
      console.warn('[RPM] setUpdateInterval gyro :', err);
    }
  };

  // Nombre d'échantillons équivalent à une durée, au taux RAPIDE du gyro
  // (les compteurs de détection sont des durées en ms, pas des échantillons).
  const nFast = (ms) => Math.max(1, Math.ceil(ms / SENSOR_FAST_INTERVAL_MS));

  // Fenêtre ADAPTATIVE de l'estimateur : après un snap (relock, arrêt,
  // relâchement, motion snap), la valeur affichée doit rejoindre la vraie
  // vitesse en ~0,25 s, pas en ~2 s. On passe la fenêtre en RAPIDE (400 ms)
  // pendant ESTIMATOR_FAST_HOLD_MS, puis on revient à LONGUE (3,5 s) pour la
  // stabilité en rotation stable.
  const useFastWindow = (now) => {
    phaseRef.current.setWindow(ESTIMATOR_FAST_WINDOW_MS);
    fastWindowUntilRef.current = now + ESTIMATOR_FAST_HOLD_MS;
  };
  const maybeRestoreWindow = (now) => {
    if (fastWindowUntilRef.current && now >= fastWindowUntilRef.current) {
      fastWindowUntilRef.current = 0;
      phaseRef.current.setWindow(ESTIMATOR_WINDOW_MS);
    }
  };

  // Cadence adaptative : 200 ms en rotation, 5 s à l'arrêt (batterie/Wi-Fi).
  // Ne recrée l'intervalle QUE si la cadence change vraiment.
  const setSendCadence = (fast) => {
    const key = fast ? 'fast' : 'slow';
    if (cadenceRef.current === key) return;
    cadenceRef.current = key;
    senderRef.current.setIntervalMs(fast ? SEND_INTERVAL_MS : SLOW_INTERVAL_MS);
    console.log(`[RPM] Cadence d'envoi : ${fast ? '200 ms (rotation)' : '5 s (arrêt)'}`);
  };

  // Vitesse standard cible (33/45/78) choisie dans l'UI. Utilisée pour
  // l'affichage et comme cible préférée du relâchement.
  const setStandardSpeed = (v) => {
    standardSpeedRef.current = v;
    setStandardSpeedState(v);
  };

  // --- Étape 1 : calibration du biais, téléphone immobile ---
  const startBiasCalibration = () => {
    biasSamplesRef.current = [];
    biasStartRef.current = Date.now();
    gainRef.current = 1; // re-calibration complète : on repart du gain neutre
    setPhase('calibratingBias');

    gyroSubRef.current = Gyroscope.addListener(({ x, y, z }) => {
      try {
        biasSamplesRef.current.push({ x, y, z });

        if (Date.now() - biasStartRef.current >= BIAS_CALIBRATION_MS) {
          const bias = computeBias(biasSamplesRef.current);
          biasRef.current = bias;
          setBiasInfo(bias);
          gyroSubRef.current?.remove();
          gyroSubRef.current = null;
          setPhase('readyToSpin');
        }
      } catch (err) {
        setSensorError('Biais : ' + (err?.message || err));
        console.error('[RPM] Erreur calibration biais :', err);
      }
    });
  };

  // --- Étape 2 : détection de l'axe dominant + mesure, platine en rotation ---
  const startMeasuring = () => {
    rejectedRef.current = 0;
    setRejectedCount(0);
    phaseRef.current.reset();
    // NOTE : le gain N'EST PAS remis à 1 ici -> le recalage auto survit d'une
    // mesure à l'autre (il n'est remis à zéro qu'à la calibration complète).
    releaseAwayRef.current = false;
    releaseCountRef.current = 0;
    releaseNearPrevRef.current = false;
    releaseArmedRef.current = false;
    wasStoppedRef.current = true;
    relockCountRef.current = 0;
    restBiasSamplesRef.current = [];
    restBiasStartRef.current = null;
    fastSpeedTrackerRef.current = null;
    stopCandidateStartRef.current = null;
    slowStopStartRef.current = null;
    setRpm(0);
    rpmRef.current = 0;
    stableOutRef.current.reset();
    stabilityRingRef.current = [];
    setStability(0);

    axisSamplesRef.current = [];
    axisStartRef.current = Date.now();
    axisVectorRef.current = null;
    setDominantAxisLabel(null);
    setPhase('calibratingAxis');

    accelSubRef.current = Accelerometer.addListener(({ x, y, z }) => {
      try {
        lastAccelMagnitudeRef.current = Math.sqrt(x * x + y * y + z * z);
      } catch (err) {
        console.error('[RPM] Erreur accéléromètre :', err);
      }
    });

    setGyroRate(true); // 100 Hz pendant la mesure (réactivité quasi-ms)

    gyroSubRef.current = Gyroscope.addListener(({ x, y, z }) => {
      try {
      // On soustrait le biais mesuré à l'étape 1
      const cx = x - biasRef.current.x;
      const cy = y - biasRef.current.y;
      const cz = z - biasRef.current.z;

      const now = Date.now();

      // --- Re-calibration continue du biais (téléphone immobile ~2 s) ---
      // Uniquement en phase de MESURE (axe déjà calibré). On utilise les
      // valeurs BRUTES : si le gyro est quasi immobile, on réestime le biais
      // (médiane, robuste) et on le mélange doucement (dérive thermique).
      const rawMag = computeMagnitude({ x, y, z });
      if (axisVectorRef.current !== null && rawMag < BIAS_REESTIMATE_RAW_MAG_MAX) {
        // Durée RÉELLE d'immobilité (le gyro est à 20 Hz à l'arrêt, pas 100 Hz
        // : compter des échantillons ferait 5x plus long). ~2 s d'immobilité
        // -> on réestime le biais (médiane, robuste) et on le mélange doucement.
        if (restBiasStartRef.current === null) restBiasStartRef.current = now;
        restBiasSamplesRef.current.push({ x, y, z });
        if (now - restBiasStartRef.current >= BIAS_REESTIMATE_MS) {
          const nb = computeBias(restBiasSamplesRef.current);
          biasRef.current = {
            x: (1 - BIAS_REESTIMATE_BLEND) * biasRef.current.x + BIAS_REESTIMATE_BLEND * nb.x,
            y: (1 - BIAS_REESTIMATE_BLEND) * biasRef.current.y + BIAS_REESTIMATE_BLEND * nb.y,
            z: (1 - BIAS_REESTIMATE_BLEND) * biasRef.current.z + BIAS_REESTIMATE_BLEND * nb.z,
          };
          restBiasSamplesRef.current = [];
          restBiasStartRef.current = null;
          console.log('[RPM] Biais recalibré à l\'arrêt:',
            biasRef.current.x.toFixed(3), biasRef.current.y.toFixed(3), biasRef.current.z.toFixed(3));
        }
      } else {
        restBiasSamplesRef.current = [];
        restBiasStartRef.current = null;
      }

      // --- Sous-phase : détection de l'axe de rotation ---
      if (axisVectorRef.current === null) {
        axisSamplesRef.current.push({ x: cx, y: cy, z: cz });

        if (now - axisStartRef.current >= AXIS_CALIBRATION_MS) {
          const { vector, label, valid } = detectRotationAxis(axisSamplesRef.current);

          if (!valid) {
            // Pas assez de rotation pendant la fenêtre : on recommence
            // (l'axe = direction du sens AVANT de la rotation)
            console.log('[RPM] Rotation insuffisante pendant la détection d\'axe, nouveau essai...');
            axisSamplesRef.current = [];
            axisStartRef.current = now;
            return;
          }

          axisVectorRef.current = vector;
          setDominantAxisLabel(label);

          // Gain INSTANTANÉ : les échantillons d'axe ont été capturés pendant
          // la rotation -> on déduit le facteur d'échelle du gyro tout de
          // suite (33.3 dès la 1re seconde, au lieu de ~20 s).
          const gainInstant = estimateGainFromSamples(axisSamplesRef.current);
          if (gainInstant !== 1) {
            gainRef.current = gainInstant;
            setGain(gainInstant);
            console.log(`[RPM] Gain pré-calibré pendant l'axe : ${gainInstant.toFixed(3)}`);
          }

          console.log(`[RPM] Axe détecté (${label}) -> phase measuring, envoi démarré`);
          setPhase('measuring');
          // Force la cadence RAPIDE réelle : l'intervalle interne du sender a
          // pu être passé à 5 s par un arrêt précédent (bug : sans ça, un
          // setSendCadence(true) était neutralisé par le garde-fou cadenceRef).
          cadenceRef.current = 'slow';
          setSendCadence(true);
          senderRef.current.start();
        }
        return;
      }

      // --- Sous-phase : mesure normale ---
      // VITESSE AXIALE = produit scalaire du gyro avec l'axe calibré.
      // Contrairement à la magnitude (sqrt(x²+y²+z²)), elle REJETTE le
      // "rocking" : si le téléphone n'est pas parfaitement fixé sur la
      // platine, il ajoute une oscillation perpendiculaire à l'axe qui
      // gonfle la magnitude (vu sur le terrain : ratio envoyé 0.79-1.54 !)
      // mais ne contribue presque pas au produit scalaire.
      const corrected = { x: cx, y: cy, z: cz };
      const dot =
        corrected.x * axisVectorRef.current.x +
        corrected.y * axisVectorRef.current.y +
        corrected.z * axisVectorRef.current.z;
      const absSpeed = Math.abs(dot);

      // --- Détection d'arrêt brutal ---
      // Si ça tournait à une vitesse significative et que ça chute d'un coup
      // à moins de 10% de cette vitesse, la platine vient de s'arrêter net.
      // On exige une chute SOUTENUE pendant ~100 ms (durée, pas échantillons)
      // pour ne pas déclencher sur le simple passage à zéro d'un scratch.
      // Quand ça déclenche : RPM à 0 et ratio 0 envoyé immédiatement au
      // serveur (au lieu d'attendre le prochain tick du sender).
      if (
        fastSpeedTrackerRef.current !== null &&
        fastSpeedTrackerRef.current > STOP_DETECTION_MIN_RAD_S &&
        absSpeed < fastSpeedTrackerRef.current * STOP_DETECTION_RATIO
      ) {
        // Chute SOUTENUE pendant ~100 ms (durée réelle, pas un compteur
        // d'échantillons : à 100 Hz, 2 échantillons = 20 ms, ce qui serait
        // déclenché par un simple passage à zéro d'un scratch).
        if (stopCandidateStartRef.current === null) stopCandidateStartRef.current = now;
        if (now - stopCandidateStartRef.current >= STOP_DETECTION_MS) {
          stopCandidateStartRef.current = null;
          phaseRef.current.snapTo(0, now);
          stableOutRef.current.snapTo(0); // sortie à 0 IMMÉDIAT (pas de lissage)
          useFastWindow(now);   // la valeur affichée revient à ~0 immédiatement
          releaseArmedRef.current = true; // un vrai arrêt arme le relâchement
          fastSpeedTrackerRef.current = 0;
          setRpm(0);
          rpmRef.current = 0;
          senderRef.current.sendNow(0);
          setSendCadence(false); // platine arrêtée : on ralentit l'envoi (5 s)
          setGyroRate(false);    // gyro à 20 Hz : économie batterie à l'arrêt
          console.log('[RPM] Arrêt brutal détecté -> reset immédiat à 0');
        }
        return;
      }
      stopCandidateStartRef.current = null;

      fastSpeedTrackerRef.current =
        fastSpeedTrackerRef.current === null
          ? absSpeed
          : STOP_DETECTION_FAST_ALPHA * absSpeed + (1 - STOP_DETECTION_FAST_ALPHA) * fastSpeedTrackerRef.current;

      const accelDeviation = Math.abs(lastAccelMagnitudeRef.current - 1);
      const isShock = accelDeviation > ACCEL_SHOCK_THRESHOLD;

      if (isShock) {
        rejectedRef.current += 1;
        setRejectedCount(rejectedRef.current);
        return;
      }

      // --- RPM : DIRECTION instantanée + vitesse axiale lissée + gain ---
      // La direction est le signe du produit scalaire (instantanée : backspin
      // et scratch changent de sens en <30ms). La vitesse axiale est lissée
      // fortement pour rester stable malgré le bruit du gyro.
      // Ré-accrochage : après un arrêt, il faut un VRAI geste (vitesse
      // soutenue ~28,6 RPM pendant 3 échantillons) pour recoller la valeur —
      // un petit mouvement du poignet (±17 RPM) ne doit plus rien déclencher.
      if (wasStoppedRef.current) {
        // En attente d'un VRAI geste : on ne laisse RIEN s'accumuler dans
        // l'estimateur (un petit mouvement du poignet ne doit produire aucun
        // blip). On ne ré-accroche qu'à la vitesse soutenue + snap direct.
        // Dès qu'un mouvement significatif apparaît, on repasse le gyro à
        // 100 Hz : le compteur de relock (3 échantillons) se remplit en
        // ~30 ms au lieu de 150 ms à 20 Hz -> redémarrage quasi instantané.
        if (absSpeed >= 1.0) setGyroRate(true);
        relockCountRef.current = relockStep(relockCountRef.current, absSpeed);
        phaseRef.current.snapTo(0, now);
        stableOutRef.current.snapTo(0);
        rpmRef.current = 0;
        if (relockCountRef.current >= RELOCK_CONSECUTIVE) {
          const relockSpeed = absSpeed * (60 / (2 * Math.PI));
          phaseRef.current.snapTo(relockSpeed, now);
          stableOutRef.current.snapTo(relockSpeed); // colle à la vitesse du geste
          useFastWindow(now);   // la valeur affichée remonte à 33 quasi tout de suite
          relockCountRef.current = 0;
          wasStoppedRef.current = false;
          setSendCadence(true); // la platine tourne de nouveau : envoi rapide
          setGyroRate(true);    // et gyro 100 Hz (réactivité)
          console.log('[RPM] Vrai mouvement détecté -> ré-accrochage direct');
        }
      } else if (absSpeed < STOPPED_RAD_S) {
        // on retombe vraiment à l'arrêt : on recolle à 0 et on se remet en
        // attente d'un vrai geste pour repartir
        wasStoppedRef.current = true;
        relockCountRef.current = 0;
        phaseRef.current.snapTo(0, now);
        stableOutRef.current.snapTo(0);
        useFastWindow(now);   // retour à 0 visible immédiatement
        releaseArmedRef.current = true; // un vrai arrêt arme le relâchement
        setRpm(0);
        rpmRef.current = 0;
        setSendCadence(false); // économie batterie à l'arrêt
        setGyroRate(false);    // et gyro à 20 Hz
      }

      const direction = absSpeed < ZERO_DEADBAND_RAD_S ? 0 : dot >= 0 ? 1 : -1;

      // ESTIMATEUR DE PHASE : intégrale signée de la vitesse axiale sur la
      // fenêtre glissante -> le bruit zéro-moyenne s'annule (stabilité) et un
      // vrai pitch déplace la pente (sensibilité). Le module sert aux
      // détections et au recalage, la direction reste instantanée.
      maybeRestoreWindow(now); // retour à la fenêtre longue après la période rapide
      const estRpm = phaseRef.current.update(dot, now);
      const axialRpm = Math.abs(estRpm);

      // --- MOTION SNAP : la magnitude suit la main pendant un VRAI geste ---
      // Pendant un scratch/backspin, la vitesse axiale SENTIE change de sens
      // instantanément, mais la fenêtre (3,5 s) met ~2 s à traverser zéro :
      // le son "traîne" derrière la main. Si la vitesse brute SIGNÉE s'écarte
      // de l'estimé de plus de MOTION_SNAP_RPM (le wobble max ~±18 RPM ne
      // peut pas l'atteindre, un geste réel si), on colle l'estimateur au
      // suivi rapide -> la magnitude répond en ~50 ms. Signe et magnitude
      // suivent donc tous les deux la main immédiatement.
      const rawRpmSigned = (dot >= 0 ? 1 : -1) * absSpeed * (60 / (2 * Math.PI));
      let rpmBrut = axialRpm;
      if (!wasStoppedRef.current && Math.abs(rawRpmSigned - estRpm) > MOTION_SNAP_RPM) {
        const fastSigned =
          (fastSpeedTrackerRef.current ?? absSpeed) * (60 / (2 * Math.PI)) * (dot >= 0 ? 1 : -1);
        phaseRef.current.snapTo(fastSigned, now);
        stableOutRef.current.snapTo(fastSigned); // la main suit immédiatement (scratch)
        useFastWindow(now);   // la magnitude suit la main immédiatement
        rpmBrut = Math.abs(fastSigned);
      }

      // --- Snap d'ARRÊT ANTICIPÉ (décélération douce) ---
      // Un arrêt "doux" (le DJ freine, ou coupe le moteur) ne franchit pas le
      // seuil d'arrêt brutal (chute sous 10% en 100 ms) : la valeur affichée
      // redescendait lentement via la fenêtre 3,5 s. Si la vitesse BRUTE tombe
      // à plus de SLOW_STOP_GAP_RPM SOUS l'estimé lissé, soutenu pendant
      // SLOW_STOP_MS, c'est une décélération réelle (et pas le wobble du
      // rocking, dont l'écart max mesuré ~15,5 RPM reste sous les 20) : on
      // accroche l'estimé au suivi rapide pour suivre en temps réel, puis 0
      // dès que < STOPPED_RAD_S.
      if (!wasStoppedRef.current && estRpm - rawRpmSigned > SLOW_STOP_GAP_RPM) {
        if (slowStopStartRef.current === null) slowStopStartRef.current = now;
        if (now - slowStopStartRef.current >= SLOW_STOP_MS) {
          slowStopStartRef.current = null;
          const fastSigned =
            (fastSpeedTrackerRef.current ?? absSpeed) * (60 / (2 * Math.PI)) * (dot >= 0 ? 1 : -1);
          phaseRef.current.snapTo(fastSigned, now);
          stableOutRef.current.snapTo(fastSigned); // décélération suivie en temps réel
          useFastWindow(now);
          rpmBrut = Math.abs(fastSigned);
        }
      } else {
        slowStopStartRef.current = null;
      }

      // --- Relâchement de la platine : accrochage direct à la standard ---
      // On passait d'une vitesse "loin" (arrêt, tenue à la main hors bande)
      // à une vitesse proche d'une standard : la platine est relâchée et
      // revient d'elle-même -> on colle la cible (33.33/45) sans rampe.
      // On détecte avec la vitesse BRUTE (la lissée serait trop lente pour
      // rattraper l'accélération physique de la platine).
      const rawRpm = absSpeed * (60 / (2 * Math.PI));

      // --- Relâchement de la platine : accrochage direct à la standard ---
      // "away" doit être SOUTENU (~300 ms) pour ne pas se déclencher sur un
      // simple passage hors bande dû au bruit, et on ne déclenche qu'à
      // l'ENTRÉE de la vitesse brute dans la bande (la platine relâchée
      // revient d'elle-même -> on colle la cible sans rampe).
      // La détection est RELATIVE à la vitesse standard choisie dans l'UI :
      // un 33 bruyant ne doit jamais déclencher un relâchement vers 45.
      const sel = standardSpeedRef.current;
      const { near, rawAway } = detectRelease(axialRpm, rawRpm, undefined, sel);
      if (releaseAwayRef.current && near && !releaseNearPrevRef.current && releaseArmedRef.current) {
        // seulement si la platine a VRAIMENT été arrêtée/tenue depuis : sans
        // ça, un 33 stable mais bruyant déclencherait des snaps en boucle.
        releaseArmedRef.current = false;
        phaseRef.current.snapTo(sel / gainRef.current, now);
        stableOutRef.current.snapTo(sel / gainRef.current); // collé à la standard
        useFastWindow(now);   // accroché à la standard immédiatement
        rpmBrut = sel / gainRef.current;
        setSendCadence(true);
        setGyroRate(true);
        console.log(`[RPM] Platine relâchée -> accrochage direct à ${sel.toFixed(1)} RPM`);
      }
      // "away" décroît au lieu de se remettre à zéro (hystérésis) : un seul
      // échantillon dans la bande (ex: juste après un ré-accrochage à ~31.8)
      // ne doit pas éteindre la détection avant l'entrée dans la bande.
      releaseCountRef.current = rawAway
        ? Math.min(2 * nFast(RELEASE_AWAY_MS), releaseCountRef.current + 1)
        : Math.max(0, releaseCountRef.current - 1);
      // ~300 ms soutenus (à 100 Hz) : l'hystérésis ne s'éteint jamais sur un
      // seul échantillon, et un bref passage hors bande ne déclenche rien.
      releaseAwayRef.current = releaseCountRef.current >= nFast(RELEASE_AWAY_MS);
      releaseNearPrevRef.current = near;

      const rpmSigne = direction * rpmBrut * gainRef.current;
      // Lisseur de SORTIE : la valeur envoyée au Pi doit être quasi constante
      // en rotation stable (Rekordbox figé à 0 pitch) tout en suivant la main
      // instantanément (les snaps ci-dessus ont déjà forcé stableOut à la
      // bonne valeur ; en régime stable la sortie est figée par la bande morte).
      const rpmFinal = stableOutRef.current.update(rpmSigne);
      rpmRef.current = rpmFinal;
      // Throttle UI : on ne re-rend que ~12 fois/s, pas à chaque échantillon
      // gyro (batterie/CPU). Le sender lit rpmRef, lui, à chaque échantillon.
      if (now - lastUiUpdateRef.current >= UI_UPDATE_INTERVAL_MS) {
        lastUiUpdateRef.current = now;
        setRpm(rpmFinal);
      }

      // Logs limités à ~2 par seconde (le gyro émet toutes les 30ms)
      const nowLog = Date.now();
      if (nowLog - lastLogTimeRef.current >= 500) {
        lastLogTimeRef.current = nowLog;
        // Recalage continu du gain vers la vitesse standard (33/45/78)
        gainRef.current = autoCorrectGain(gainRef.current, axialRpm);
        setGain(gainRef.current);

        // Stabilité affichée : déviation du RPM BRUT (suivi rapide) sur les
        // ~3 dernières s -> indicateur réel de la fixation du téléphone (le
        // lissé serait quasi constant et ne dirait rien).
        stabilityRingRef.current.push((fastSpeedTrackerRef.current ?? 0) * (60 / (2 * Math.PI)));
        if (stabilityRingRef.current.length > 6) stabilityRingRef.current.shift();
        if (stabilityRingRef.current.length >= 2) {
          const min = Math.min(...stabilityRingRef.current);
          const max = Math.max(...stabilityRingRef.current);
          setStability((max - min) / 2);
        }
        console.log(
          `[RPM] lissé: ${(direction * axialRpm * gainRef.current).toFixed(2)} | brut: ${(absSpeed * (60 / (2 * Math.PI))).toFixed(2)} | gain: ${gainRef.current.toFixed(3)} | axe: ${axisVectorRef.current.x.toFixed(2)},${axisVectorRef.current.y.toFixed(2)},${axisVectorRef.current.z.toFixed(2)} | rejets: ${rejectedRef.current}`
        );
      }
      } catch (err) {
        setSensorError((err?.message || String(err)).slice(0, 200));
        console.error('[RPM] Erreur callback gyro :', err);
      }
    });
  };

  const stop = () => {
    gyroSubRef.current?.remove();
    accelSubRef.current?.remove();
    gyroSubRef.current = null;
    accelSubRef.current = null;
    // Envoie ratio 0 (pause côté serveur) puis coupe l'envoi périodique.
    senderRef.current.sendNow(0);
    senderRef.current.stop();
    setGyroRate(false); // retour au taux économie
    setSendStatus('idle');
    setPhase('idle');
  };

  // Envoie une valeur de test immédiate (ratio 1.0 = vitesse normale) pour
  // vérifier que le serveur du Pi est joignable, sans passer par la mesure.
  // Le résultat apparaît via sendStatus (ok / error).
  const testSend = () => {
    setSendStatus('idle');
    senderRef.current.sendNow(1.0);
  };

  return {
    // état à afficher
    phase,
    rpm,
    rejectedCount,
    dominantAxisLabel,
    biasInfo,
    sendStatus,
    sensorError,
    gain,
    standardSpeed,
    stability,
    // actions
    startBiasCalibration,
    startMeasuring,
    stop,
    testSend,
    setStandardSpeed,
  };
}