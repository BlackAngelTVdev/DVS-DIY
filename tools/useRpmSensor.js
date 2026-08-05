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
  createSmoother,
  autoCorrectGain,
  estimateGainFromSamples,
  detectRelease,
  relockStep,
  RELOCK_CONSECUTIVE,
  STOPPED_RAD_S,
  closestStandard,
  ZERO_DEADBAND_RAD_S,
  CALIBRATION_TIMINGS,
} from './calibration';
import { createSpeedSender, SEND_INTERVAL_MS, SLOW_INTERVAL_MS } from './speedSender';

const { BIAS_CALIBRATION_MS, AXIS_CALIBRATION_MS } = CALIBRATION_TIMINGS;

// --- Optimisation batterie ---
// Le gyro tourne à 20 Hz (50 ms) au lieu de 33 Hz : amplement suffisant
// pour le DVS (le lissage fait le reste) et ~40% d'énergie capteur en moins.
// L'accéléromètre ne sert qu'au rejet de choc -> encore moins sollicité.
const SENSOR_UPDATE_INTERVAL_MS = 50;
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
// Il faut 2 échantillons consécutifs sous le seuil pour déclencher l'arrêt :
// un simple croisement du zéro pendant un scratch/backspin ne suffit pas.
const STOP_DETECTION_CONSECUTIVE = 2;

// Re-calibration continue du biais : quand le téléphone est immobile (platine
// à l'arrêt) pendant ~2 s, on réestime le biais et on le mélange doucement au
// biais actuel (compense la dérive du gyro avec la chaleur/temps).
const BIAS_REESTIMATE_RAW_MAG_MAX = 0.35; // rad/s : en dessous = immobile
const BIAS_REESTIMATE_SAMPLES = 40;        // ~2 s à 50 ms
const BIAS_REESTIMATE_BLEND = 0.15;        // part du nouveau biais dans le mélange

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
  const smootherRef = useRef(createSmoother()); // lisse la vitesse axiale (pas la direction)
  const gainRef = useRef(1);                    // recalage auto de la vitesse (vers 33/45/78)
  const releaseAwayRef = useRef(false);         // état "loin d'une standard" SOUTENU
  const releaseCountRef = useRef(0);            // compteur d'échantillons away consécutifs
  const releaseNearPrevRef = useRef(false);     // pour ne déclencher qu'à l'ENTRÉE dans la bande
  const wasStoppedRef = useRef(true);           // pour ré-accrocher vite au redémarrage
  const relockCountRef = useRef(0);             // compteur du ré-accrochage (vrai geste requis)
  const lastUiUpdateRef = useRef(0);            // throttle des re-renders UI
  const restBiasSamplesRef = useRef([]);        // échantillons à l'arrêt -> re-calibration du biais
  const fastSpeedTrackerRef = useRef(null);     // suivi rapide pour détecter les arrêts brutaux
  const stopCandidateCountRef = useRef(0);      // échantillons consécutifs sous le seuil d'arrêt
  const lastLogTimeRef = useRef(0);             // pour limiter la fréquence des logs
  const standardSpeedRef = useRef(33.33);       // miroir de standardSpeed pour le callback gyro
  const stabilityRingRef = useRef([]);          // dernières valeurs lissées -> déviation
  const cadenceRef = useRef('fast');            // cadence d'envoi (fast 200 ms / slow 5 s)

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
    smootherRef.current.reset();
    // NOTE : le gain N'EST PAS remis à 1 ici -> le recalage auto survit d'une
    // mesure à l'autre (il n'est remis à zéro qu'à la calibration complète).
    releaseAwayRef.current = false;
    releaseCountRef.current = 0;
    releaseNearPrevRef.current = false;
    wasStoppedRef.current = true;
    relockCountRef.current = 0;
    restBiasSamplesRef.current = [];
    fastSpeedTrackerRef.current = null;
    stopCandidateCountRef.current = 0;
    setRpm(0);
    rpmRef.current = 0;
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
        restBiasSamplesRef.current.push({ x, y, z });
        if (restBiasSamplesRef.current.length >= BIAS_REESTIMATE_SAMPLES) {
          const nb = computeBias(restBiasSamplesRef.current);
          biasRef.current = {
            x: (1 - BIAS_REESTIMATE_BLEND) * biasRef.current.x + BIAS_REESTIMATE_BLEND * nb.x,
            y: (1 - BIAS_REESTIMATE_BLEND) * biasRef.current.y + BIAS_REESTIMATE_BLEND * nb.y,
            z: (1 - BIAS_REESTIMATE_BLEND) * biasRef.current.z + BIAS_REESTIMATE_BLEND * nb.z,
          };
          restBiasSamplesRef.current = [];
          console.log('[RPM] Biais recalibré à l\'arrêt:',
            biasRef.current.x.toFixed(3), biasRef.current.y.toFixed(3), biasRef.current.z.toFixed(3));
        }
      } else {
        restBiasSamplesRef.current = [];
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
      // On exige STOP_DETECTION_CONSECUTIVE échantillons de suite pour ne pas
      // déclencher sur le simple passage à zéro d'un scratch/backspin.
      // Quand ça déclenche : RPM à 0 et ratio 0 envoyé immédiatement au
      // serveur (au lieu d'attendre le prochain tick du sender).
      if (
        fastSpeedTrackerRef.current !== null &&
        fastSpeedTrackerRef.current > STOP_DETECTION_MIN_RAD_S &&
        absSpeed < fastSpeedTrackerRef.current * STOP_DETECTION_RATIO
      ) {
        stopCandidateCountRef.current += 1;
        // on ne met PAS à jour le tracker pendant un candidat, sinon il
        // chuterait à sa propre valeur et la condition ne tiendrait plus
        if (stopCandidateCountRef.current >= STOP_DETECTION_CONSECUTIVE) {
          stopCandidateCountRef.current = 0;
          smootherRef.current.snapTo(0);
          fastSpeedTrackerRef.current = 0;
          setRpm(0);
          rpmRef.current = 0;
          senderRef.current.sendNow(0);
          setSendCadence(false); // platine arrêtée : on ralentit l'envoi (5 s)
          console.log('[RPM] Arrêt brutal détecté -> reset immédiat à 0');
        }
        return;
      }
      stopCandidateCountRef.current = 0;

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
        if (absSpeed < STOPPED_RAD_S) {
          // toujours (quasi) à l'arrêt : on recolle à 0 pour ne laisser
          // aucune traîne résiduelle après un petit geste
          smootherRef.current.snapTo(0);
          relockCountRef.current = 0;
          rpmRef.current = 0;
        } else {
          relockCountRef.current = relockStep(relockCountRef.current, absSpeed);
          if (relockCountRef.current >= RELOCK_CONSECUTIVE) {
            smootherRef.current.snapTo(absSpeed * (60 / (2 * Math.PI)));
            relockCountRef.current = 0;
            wasStoppedRef.current = false;
            setSendCadence(true); // la platine tourne de nouveau : envoi rapide
            console.log('[RPM] Vrai mouvement détecté -> ré-accrochage direct');
          }
        }
      } else if (absSpeed < STOPPED_RAD_S) {
        // on retombe vraiment à l'arrêt : on recolle à 0 et on se remet en
        // attente d'un vrai geste pour repartir
        wasStoppedRef.current = true;
        relockCountRef.current = 0;
        smootherRef.current.snapTo(0);
        setRpm(0);
        rpmRef.current = 0;
        setSendCadence(false); // économie batterie à l'arrêt
      }

      const direction = absSpeed < ZERO_DEADBAND_RAD_S ? 0 : dot >= 0 ? 1 : -1;

      const axialRpm = smootherRef.current.update(absSpeed * (60 / (2 * Math.PI)));

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
      const { near, rawAway } = detectRelease(axialRpm, rawRpm);
      let rpmBrut = axialRpm;
      if (releaseAwayRef.current && near && !releaseNearPrevRef.current) {
        // cible = vitesse standard choisie dans l'UI si la platine y revient,
        // sinon la standard la plus proche de la vitesse réelle
        const sel = standardSpeedRef.current;
        const cible = Math.abs(rawRpm - sel) <= sel * 0.06 ? sel : closestStandard(rawRpm);
        smootherRef.current.snapTo(cible / gainRef.current);
        rpmBrut = cible / gainRef.current;
        setSendCadence(true);
        console.log(`[RPM] Platine relâchée -> accrochage direct à ${cible.toFixed(1)} RPM`);
      }
      releaseCountRef.current = rawAway ? Math.min(50, releaseCountRef.current + 1) : 0;
      releaseAwayRef.current = releaseCountRef.current >= 10; // ~500 ms soutenus à 50 ms
      releaseNearPrevRef.current = near;

      const rpmSigne = direction * rpmBrut * gainRef.current;
      rpmRef.current = rpmSigne;
      // Throttle UI : on ne re-rend que ~12 fois/s, pas à chaque échantillon
      // gyro (batterie/CPU). Le sender lit rpmRef, lui, à chaque échantillon.
      if (now - lastUiUpdateRef.current >= UI_UPDATE_INTERVAL_MS) {
        lastUiUpdateRef.current = now;
        setRpm(rpmSigne);
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