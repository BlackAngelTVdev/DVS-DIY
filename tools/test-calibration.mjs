// Test de la chaîne de mesure DVS avec données simulées.
// Exécution : npm test  (ou : node tools/test-calibration.mjs)
//
// calibration.js utilise la syntaxe ESM mais le projet n'a pas "type":
// "module", donc on copie le fichier vers un .mjs temporaire avant de
// l'importer. Auto-nettoyage à la fin.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'dvs-calib-'));
const modPath = join(dir, 'calibration.mjs');
writeFileSync(modPath, readFileSync(fileURLToPath(new URL('./calibration.js', import.meta.url)), 'utf8'));

const {
  computeBias,
  computeMagnitude,
  detectRotationAxis,
  createPhaseEstimator,
  autoCorrectGain,
  estimateGainFromSamples,
  detectRelease,
  relockStep,
  MOTION_SNAP_RPM,
  RELOCK_MIN_RAD_S,
  RELOCK_CONSECUTIVE,
  closestStandard,
  ZERO_DEADBAND_RAD_S,
  CALIBRATION_TIMINGS,
} = await import(`file://${modPath}`);

// speedSender.js est aussi en ESM : même copie vers un .mjs temporaire
const senderModPath = join(dir, 'speedSender.mjs');
writeFileSync(senderModPath, readFileSync(fileURLToPath(new URL('./speedSender.js', import.meta.url)), 'utf8'));
const { createSpeedSender, SLOW_INTERVAL_MS, SEND_INTERVAL_MS } = await import(`file://${senderModPath}`);

try {
  const RAD2RPM = 60 / (2 * Math.PI);
  const RPM33 = 3.49066; // 33.33 RPM en rad/s
  let pass = 0, fail = 0;
  const check = (name, cond, extra) => {
    if (cond) { pass++; console.log(`  \u2705 ${name}`); }
    else { fail++; console.log(`  \u274c ${name} ${extra ?? ''}`); }
  };
  const close = (a, b, tol) => Math.abs(a - b) <= tol;
  // PRNG déterministe (mulberry32) : résultats reproductibles d'un run à l'autre
  const rand = (() => {
    let seed = 1337;
    return () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  })();
  const noise = (amp) => (rand() * 2 - 1) * amp;

  // --- 1. Biais robuste : un outlier ne doit rien casser ---
  console.log('\n[1] Biais par mediane (robuste aux outliers)');
  {
    const samples = [
      { x: 0.05, y: 0.01, z: 0.02 },
      { x: 0.06, y: 0.02, z: 0.03 },
      { x: 6.0, y: -4.0, z: 5.0 }, // outlier : le telephone a bouge
      { x: 0.055, y: 0.015, z: 0.025 },
      { x: 0.05, y: 0.02, z: 0.02 },
    ];
    const bias = computeBias(samples);
    check('biais x ~0.055 (median, pas 1.24 = moyenne)', close(bias.x, 0.055, 0.001), JSON.stringify(bias));
    check('biais y ~0.015', close(bias.y, 0.015, 0.001), JSON.stringify(bias));
    check('biais z ~0.025', close(bias.z, 0.025, 0.001), JSON.stringify(bias));
  }

  // --- 2. Détection d'axe ---
  console.log('\n[2] Detection de l\'axe de rotation');
  {
    const flat = Array.from({ length: 50 }, () => ({ x: noise(0.01), y: noise(0.01), z: RPM33 + noise(0.05) }));
    const { vector, label, valid } = detectRotationAxis(flat);
    check('valide', valid);
    check('axe ~ (0,0,1)', close(vector.x, 0, 0.01) && close(vector.y, 0, 0.01) && close(vector.z, 1, 0.01), JSON.stringify(vector));
    check('label = Z', label === 'Z', label);

    const tilted = Array.from({ length: 50 }, () => ({
      x: noise(0.01),
      y: RPM33 * Math.sin(Math.PI / 6) + noise(0.05),
      z: RPM33 * Math.cos(Math.PI / 6) + noise(0.05),
    }));
    const r2 = detectRotationAxis(tilted);
    check('axe incline valide', r2.valid);
    check('|vector| = 1', close(computeMagnitude(r2.vector), 1, 0.01), JSON.stringify(r2.vector));
  }

  // --- 3. Simulateur complet du pipeline (biais + axe + lissage) ---
  console.log('\n[3] RPM final avec le pipeline complet (biais + axe + lissage)');
  function simulate(samples, bias) {
    const corrected = samples.map((s) => ({ x: s.x - bias.x, y: s.y - bias.y, z: s.z - bias.z }));
    const { vector } = detectRotationAxis(corrected.slice(0, 50));
    if (!vector) return null;
    // le hook utilise l'estimateur de PHASE (intégrale fenêtrée 3,5 s)
    const estimator = createPhaseEstimator();
    let t = 0; // temps simulé (ms), +50 ms par échantillon
    let tracker = null;
    let stopCount = 0;
    let releaseAway = false, releaseCount = 0, nearPrev = false;
    let releaseArmed = false; // relâchement armé seulement après un VRAI arrêt
    let wasStopped = true, relockCount = 0; // ré-accrochage strict (comme le hook)
    const gain = 1.0;
    const trace = [];
    for (const s of corrected.slice(50)) {
      t += 50;
      // vitesse AXIALE SIGNÉE = produit scalaire avec l'axe calibré
      const dot = s.x * vector.x + s.y * vector.y + s.z * vector.z;
      const absSpeed = Math.abs(dot);
      // détection d'arrêt brutal (comme dans le hook)
      if (tracker !== null && tracker > 1.0 && absSpeed < tracker * 0.1) {
        stopCount += 1;
        if (stopCount >= 2) {
          stopCount = 0;
          tracker = 0;
          estimator.snapTo(0, t);
          releaseArmed = true;
          trace.push(0);
          continue;
        }
        trace.push(estimator.update(dot, t));
        continue;
      }
      stopCount = 0;
      tracker = tracker === null ? absSpeed : 0.35 * absSpeed + 0.65 * tracker;
      // en attente d'un vrai geste : rien ne s'accumule (comme le hook)
      if (wasStopped) {
        relockCount = relockStep(relockCount, absSpeed);
        estimator.snapTo(0, t);
        if (relockCount >= RELOCK_CONSECUTIVE) {
          estimator.snapTo(absSpeed * RAD2RPM, t);
          relockCount = 0;
          wasStopped = false;
        }
      } else if (absSpeed < 1.0) {
        wasStopped = true;
        relockCount = 0;
        estimator.snapTo(0, t);
        releaseArmed = true;
      }
      const direction = absSpeed < ZERO_DEADBAND_RAD_S ? 0 : dot >= 0 ? 1 : -1;
      let module = Math.abs(estimator.update(dot, t));
      // relâchement : accrochage direct à la standard (sur la vitesse BRUTE)
      const rawRpm = absSpeed * RAD2RPM;
      // cible = 33.33 : la détection ne doit JAMAIS viser une autre standard
      // (un 33 bruyant qui monte à 43 ne déclenche pas de snap vers 45)
      const { near, rawAway } = detectRelease(module, rawRpm, undefined, 33.33);
      if (releaseAway && near && !nearPrev && releaseArmed) {
        releaseArmed = false;
        estimator.snapTo(33.33 / gain, t);
        module = 33.33 / gain;
      }
      // hystérésis : décroît au lieu de se remettre à zéro (comme le hook)
      releaseCount = rawAway ? Math.min(50, releaseCount + 1) : Math.max(0, releaseCount - 1);
      releaseAway = releaseCount >= 10;
      nearPrev = near;
      trace.push(direction * module);
    }
    return { ema: trace[trace.length - 1], vector, trace };
  }

  // a) 33 RPM a plat
  {
    const bias = { x: 0.02, y: -0.03, z: 0.015 };
    const samples = Array.from({ length: 150 }, () => ({
      x: bias.x + noise(0.02), y: bias.y + noise(0.02), z: bias.z + RPM33 + noise(0.05),
    }));
    const r = simulate(samples, bias);
    check('33.33 RPM a plat -> ~33.3', r && close(r.ema, 33.33, 1.0), r?.ema?.toFixed(2));
  }

  // b) LE BUG : telephone incline de 30° (ancienne methode: 16.6, nouvelle: 33.3)
  {
    const bias = { x: 0, y: 0, z: 0 };
    const samples = Array.from({ length: 150 }, () => ({
      x: noise(0.02),
      y: RPM33 * Math.sin(Math.PI / 6) + noise(0.05),
      z: RPM33 * Math.cos(Math.PI / 6) + noise(0.05),
    }));
    const r = simulate(samples, bias);
    const oldMethod = Math.abs(samples[75].y - bias.y) * RAD2RPM;
    console.log(`     ancienne methode (axe unique) : ${oldMethod.toFixed(1)} RPM`);
    check('33.33 RPM incline 30° -> ~33.3 (magnitude)', r && close(r.ema, 33.33, 1.0), r?.ema?.toFixed(2));
    check('ancienne methode sous-estimait (16.6)', close(oldMethod, 16.67, 1.0), oldMethod.toFixed(1));
  }

  // c) Backspin : calibration en avant, PUIS rotation arriere -> RPM negatif
  {
    const bias = { x: 0, y: 0, z: 0 };
    const samples = [];
    for (let i = 0; i < 50; i++) samples.push({ x: noise(0.02), y: noise(0.02), z: RPM33 + noise(0.05) });
    for (let i = 0; i < 100; i++) samples.push({ x: noise(0.02), y: noise(0.02), z: -RPM33 + noise(0.05) });
    const r = simulate(samples, bias);
    check('backspin -> ~ -33.3 RPM', r && close(r.ema, -33.33, 1.0), r?.ema?.toFixed(2));
  }

  // d) Scratch : alternance avant/arriere rapide -> le signe doit suivre
  //    (l'estimateur de phase lisse la MAGNITUDE : un scratch est un geste,
  //    pas un pitch -> on vérifie le sens, et la convergence d'un backspin
  //    SOUTENU vers -33 une fois la fenêtre pleine)
  {
    const bias = { x: 0, y: 0, z: 0 };
    const samples = [];
    for (let i = 0; i < 60; i++) samples.push({ x: noise(0.02), y: noise(0.02), z: RPM33 + noise(0.05) });
    for (let i = 0; i < 100; i++) samples.push({ x: noise(0.02), y: noise(0.02), z: -RPM33 + noise(0.05) });
    const r = simulate(samples, bias);
    const secondHalf = r.trace.slice(60);
    const avgSecondHalf = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
    const last10 = r.trace.slice(-10);
    const avgLast10 = last10.reduce((a, b) => a + b, 0) / last10.length;
    check('scratch : 2e moitie en negatif', avgSecondHalf < 0, avgSecondHalf.toFixed(1));
    check('scratch : backspin soutenu -> ~-33 en fin de fenêtre', close(avgLast10, -33.33, 1.5), avgLast10.toFixed(1));
  }

  // e) Arret brutal : plateau stoppe -> retombe vers 0
  {
    const bias = { x: 0, y: 0, z: 0 };
    const samples = Array.from({ length: 60 }, () => ({ x: noise(0.02), y: noise(0.02), z: RPM33 + noise(0.05) }));
    for (let i = 0; i < 40; i++) samples.push({ x: noise(0.05), y: noise(0.05), z: noise(0.05) });
    const r = simulate(samples, bias);
    check('arret -> RPM final proche de 0', close(r.trace[r.trace.length - 1], 0, 1.5), r.trace[r.trace.length - 1].toFixed(2));
  }

  // f) LE VRAI PROBLÈME DE TERRAIN : platine à 33 mais gyro bruyant
  //    (±15 RPM d'oscillation, pire que les logs réels 28-40) -> le lissage
  //    doit sortir une valeur quasi constante, et le signe rester positif.
  {
    const bias = { x: 0, y: 0, z: 0 };
    const samples = [];
    for (let i = 0; i < 50; i++) samples.push({ x: noise(0.02), y: noise(0.02), z: RPM33 + noise(0.05) });
    for (let i = 0; i < 300; i++) {
      const wobble = 1.55 * Math.sin((2 * Math.PI * 1.5 * i) / 33.33); // ±15 RPM à ~1.5 Hz
      const spike = Math.random() < 0.02 ? (Math.random() * 2 - 1) * 1.0 : 0; // pics aléatoires
      samples.push({ x: noise(0.02), y: noise(0.02), z: RPM33 + wobble + spike + noise(0.05) });
    }
    const r = simulate(samples, bias);
    const last = r.trace.slice(-50); // dernière 1,5 s
    const avg = last.reduce((a, b) => a + b, 0) / last.length;
    const min = Math.min(...last), max = Math.max(...last);
    console.log(`     brut oscillait entre ${Math.min(...samples.slice(50).map((s) => s.z * RAD2RPM)).toFixed(1)} et ${Math.max(...samples.slice(50).map((s) => s.z * RAD2RPM)).toFixed(1)} RPM`);
    console.log(`     lissé : moyenne ${avg.toFixed(1)} | min ${min.toFixed(1)} | max ${max.toFixed(1)}`);
    check('gyro bruyant : moyenne proche de 33', close(avg, 33.33, 2.0), avg.toFixed(1));
    check('gyro bruyant : oscillation réduite (< 3 RPM)', max - min < 3, `${(max - min).toFixed(1)} RPM`);
    check('gyro bruyant : signe toujours positif (pas de faux backspin)', min > 0, min.toFixed(1));
  }

  // g) Backspin détecté INSTANTANÉMENT (le signe saute en <150 ms)
  {
    const bias = { x: 0, y: 0, z: 0 };
    const samples = [];
    for (let i = 0; i < 50; i++) samples.push({ x: noise(0.02), y: noise(0.02), z: RPM33 + noise(0.05) });
    for (let i = 0; i < 60; i++) samples.push({ x: noise(0.02), y: noise(0.02), z: RPM33 + noise(0.05) });
    for (let i = 0; i < 60; i++) samples.push({ x: noise(0.02), y: noise(0.02), z: -RPM33 + noise(0.05) });
    const r = simulate(samples, bias);
    const firstBackspin = r.trace.findIndex((v, i) => i >= 58 && v < 0);
    check('backspin : signe négatif en <5 échantillons (150 ms)', firstBackspin >= 58 && firstBackspin <= 63, `au sample ${firstBackspin}`);
  }

  // h) LE VRAI SIGNAL DE TERRAIN : téléphone pas parfaitement fixé -> le
  //    gyro fluctue réellement (±37% : ratio 0.79-1.54 dans les logs).
  //    Le lissage (app + serveur) doit ramener ça à ±2 RPM.
  {
    const bias = { x: 0, y: 0, z: 0 };
    const samples = [];
    for (let i = 0; i < 50; i++) samples.push({ x: noise(0.02), y: noise(0.02), z: RPM33 + noise(0.05) });
    const ratios = [];
    for (let i = 0; i < 300; i++) {
      const t = i / 33.33;
      const slip = 0.37 * Math.sin(2 * Math.PI * 0.4 * t); // ±37% à 0.4 Hz
      const wz = RPM33 * (1 + slip) + noise(0.05);
      samples.push({ x: noise(0.02), y: noise(0.02), z: wz });
      ratios.push(wz * RAD2RPM / 33.33);
    }
    const r = simulate(samples, bias);
    const last = r.trace.slice(-50);
    const min = Math.min(...last), max = Math.max(...last);
    const minMag = Math.min(...ratios.slice(50)).toFixed(2);
    const maxMag = Math.max(...ratios.slice(50)).toFixed(2);
    console.log(`     brut (sans lissage) : ratio ${minMag} -> ${maxMag}  (comme tes logs !)`);
    console.log(`     après lissage app : ${min.toFixed(1)} -> ${max.toFixed(1)} RPM`);
    check('signal terrain : brut bien oscillant (ratio < 0.85)', Number(minMag) < 0.85, minMag);
    check('signal terrain : brut bien oscillant (ratio > 1.3)', Number(maxMag) > 1.3, maxMag);
    check('signal terrain : après lissage app, ±4 RPM de 33', min > 29 && max < 37.5, `${min.toFixed(1)} -> ${max.toFixed(1)}`);
  }

  // i) Rampe lente : pas de faux backspin malgré l'oscillation de l'axe
  {
    const bias = { x: 0, y: 0, z: 0 };
    const samples = [];
    for (let i = 0; i < 50; i++) samples.push({ x: noise(0.02), y: noise(0.02), z: RPM33 + noise(0.05) });
    const slow = 0.55; // rad/s ≈ 5 RPM
    for (let i = 0; i < 150; i++) {
      const t = i / 33.33;
      const tilt = Math.sin(2 * Math.PI * 1.5 * t) * 0.5;
      const zz = slow * Math.cos(tilt) + noise(0.05);
      const yy = slow * Math.sin(tilt) + noise(0.05);
      samples.push({ x: noise(0.02), y: yy, z: zz });
    }
    const r = simulate(samples, bias);
    const last50 = r.trace.slice(-50);
    const nbNegatifs = last50.filter((v) => v < 0).length;
    check('rampe lente : pas de faux backspin (0 valeur négative)', nbNegatifs === 0, `${nbNegatifs} valeurs négatives`);
  }

  // --- 4. Recalage automatique du gain (31-32 -> 33.3) ---
  console.log('\n[4] Recalage automatique du gain');
  {
    // a) 33.0 RPM (dérive résiduelle < 2%) -> le gain corrige doucement vers 33.33
    let gain = 1.0;
    for (let i = 0; i < 5000; i++) gain = autoCorrectGain(gain, 33.0);
    check('33.0 RPM (dérive < 2%) -> corrigé vers 33.3', close(33.0 * gain, 33.33, 0.3), `33.0*${gain.toFixed(3)}=${(33.0 * gain).toFixed(1)}`);

    // b) 33.33 exact -> gain stable
    let g2 = 1.0;
    for (let i = 0; i < 5000; i++) g2 = autoCorrectGain(g2, 33.33);
    check('33.33 -> gain inchangé', close(g2, 1.0, 0.01), g2.toFixed(3));

    // c) 44.5 RPM (dérive < 2% de 45) -> corrigé vers 45
    let g3 = 1.0;
    for (let i = 0; i < 5000; i++) g3 = autoCorrectGain(g3, 44.5);
    check('44.5 RPM -> corrigé vers 45', close(44.5 * g3, 45, 0.3), `${(44.5 * g3).toFixed(1)}`);

    // c2) PITCH : 34.5 RPM (pitch +3,5%) -> PAS touché (sensibilité au pitch)
    let gP = 1.0;
    for (let i = 0; i < 5000; i++) gP = autoCorrectGain(gP, 34.5);
    check('pitch +3,5% (34.5) -> gain inchangé', close(gP, 1.0, 0.001), gP.toFixed(3));

    // c3) LE CAS TERRAIN (le bug) : gyro qui lit 32.4 (2,8% bas) avec un gain
    //    déjà posé par la calib d'axe (1.009). L'ANCIEN code jugeait 32.4 hors
    //    bande (±2% de 33.33) et ramenait le gain vers 1 -> affiché 32.7 en
    //    permanence. Le nouveau code teste la bande sur la vitesse CORRIGÉE
    //    (brut × gain) : le gain remonte vers 33.33/32.4 ≈ 1.029.
    let gT = 1.009;
    for (let i = 0; i < 20000; i++) gT = autoCorrectGain(gT, 32.4);
    check('cas terrain 32.4 -> gain remonte à ~1.028', close(gT, 33.33 / 32.4, 0.003), gT.toFixed(4));
    check('cas terrain 32.4 -> RPM affiché ~33.3', close(32.4 * gT, 33.33, 0.3), (32.4 * gT).toFixed(1));

    // c4) PITCH + gain légitime (le point de la review) : la platine est en
    //    pitch +3,5% (34.5 vrai = 33.5 brut avec gyro 2,8% bas) et le gain
    //    d'échelle 1.028 est déjà posé. L'ancien anti-verrou hors bande le
    //    dissolvait lentement -> l'affichage dérivait de 34.5 vers 33.5.
    //    Désormais un gain légitime (|gain-1| <= 5%) n'est JAMAIS touché.
    let gP2 = 1.0287;
    for (let i = 0; i < 20000; i++) gP2 = autoCorrectGain(gP2, 33.5); // brut d'un 34.5 vrai
    check('pitch 34.5 + gain légitime -> gain intact', close(gP2, 1.0287, 0.002), gP2.toFixed(4));
    check('pitch 34.5 + gain légitime -> RPM affiché ~34.5', close(33.5 * gP2, 34.5, 0.3), (33.5 * gP2).toFixed(1));

    // d) 30 RPM (10% hors bande, décalage volontaire du DJ) -> PAS touché
    let g4 = 1.0;
    for (let i = 0; i < 5000; i++) g4 = autoCorrectGain(g4, 30.0);
    check('30 RPM (hors bande) -> gain inchangé', close(g4, 1.0, 0.001), g4.toFixed(3));

    // e) clamp du gain
    let g5 = 1.2;
    g5 = autoCorrectGain(g5, 33.33);
    check('gain clampé à 1.12 max', g5 <= 1.12, g5.toFixed(3));

    // f) gain erroné (ex: gain posé par erreur à 1.11 pendant l'axe) qui
    //    pousse la lecture hors bande -> il DOIT décroître, jamais d'erreur
    //    verrouillée. Il décroît jusqu'à la frontière de la bande légitime
    //    (|gain-1| <= 5%) puis s'y stabilise : en dessous, on présume le gain
    //    légitime et on ne le touche plus (sinon un pitch réel éroderait la
    //    compensation d'échelle — cf. c4).
    let g6 = 1.11;
    for (let i = 0; i < 5000; i++) g6 = autoCorrectGain(g6, 37.0); // lecture corrigée hors bande
    check('gain erroné hors bande -> décroît sous 1.05 (pas de verrou)', g6 <= 1.05, g6.toFixed(3));
    check('gain erroné hors bande -> a bien décru (1.11 -> <1.06)', g6 < 1.06, g6.toFixed(3));
  }

  // --- 4b. Gain INSTANTANÉ pendant la détection d'axe ---
  // (plus besoin d'attendre ~20 s : le facteur d'échelle est déduit tout de
  // suite des échantillons capturés pendant la rotation d'axe)
  console.log('\n[4b] Gain instantané (estimateGainFromSamples)');
  {
    const rad2rpm = (rpm) => (rpm * 2 * Math.PI) / 60;
    const spin = (rpm) =>
      Array.from({ length: 40 }, () => ({ x: noise(0.01), y: noise(0.01), z: rad2rpm(rpm) + noise(0.05) }));

    const g1 = estimateGainFromSamples(spin(31.8));
    check('gyro lit 31.8 (platine à 33.33) -> gain ~1.048', close(g1, 33.33 / 31.8, 0.01), g1.toFixed(4));

    const g2 = estimateGainFromSamples(spin(33.3));
    check('33.3 mesuré -> gain ~1.000', close(g2, 1, 0.01), g2.toFixed(4));

    const g3 = estimateGainFromSamples(spin(45));
    check('45 mesuré -> gain ~1.000', close(g3, 1, 0.01), g3.toFixed(4));

    check('20 RPM (hors bande, tenue à la main) -> gain 1', estimateGainFromSamples(spin(20)) === 1);

    const stopped = Array.from({ length: 40 }, () => ({ x: noise(0.01), y: noise(0.01), z: noise(0.01) }));
    check('à l\'arrêt -> gain 1 (pas de fausse calibration)', estimateGainFromSamples(stopped) === 1);

    const few = [{ x: 0, y: 0, z: RPM33 }, { x: 0, y: 0, z: RPM33 }, { x: 0, y: 0, z: RPM33 }];
    check('3 échantillons seulement -> gain 1', estimateGainFromSamples(few) === 1);
  }

  // --- 5. Relâchement de la platine (backspin/arrêt -> retour à 33 direct) ---
  console.log('\n[5] Relâchement de la platine');
  {
    // a) unit : 33 -> arrêt -> retour dans la bande
    let r = detectRelease(33.0, 33.0);
    check('à 33 : pas away, proche standard', !r.rawAway && r.near, JSON.stringify(r));
    r = detectRelease(0.5, 0.5);
    check('arrêt : away, pas proche', r.rawAway && !r.near, JSON.stringify(r));
    r = detectRelease(32.0, 32.0);
    check('retour ~33 : proche (bande)', !r.rawAway && r.near, JSON.stringify(r));

    // b) tenue à la main à 20 RPM : away, jamais proche -> pas de relâchement
    for (let i = 0; i < 100; i++) {
      r = detectRelease(20.0, 20.0);
    }
    check('tenue à 20 RPM : away soutenu', r.rawAway && !r.near, JSON.stringify(r));

    // c) backspin -33 : la MAGNITUDE est déjà ~33 (proche standard) -> pas de
    //    snap nécessaire (la direction instantanée s'occupe du signe).
    r = detectRelease(33.0, 33.0);
    check('backspin plein régime : proche standard (pas away)', !r.rawAway && r.near, JSON.stringify(r));
    // d) demi-vitesse en arrière -> loin de la standard -> away
    r = detectRelease(16.0, 16.0);
    check('backspin lent : away', r.rawAway, JSON.stringify(r));

    // e) ROBUSTESSE AU BRUIT : platine stable à 33 (lissé) mais brut qui
    //    oscille 20-46 -> jamais "away" (pas de faux accrochage)
    let everAway = false;
    for (let i = 0; i < 300; i++) {
      const raw = 33 + 13 * Math.sin((2 * Math.PI * 1.5 * i) / 33.33);
      const rr = detectRelease(33.0, raw);
      everAway = everAway || rr.rawAway;
    }
    check('bruit ±13 : jamais away (lissé stable)', !everAway);
  }

  // --- 6. Pipeline : arrêt puis relâchement -> accrochage rapide (pas de rampe)
  console.log('\n[6] Pipeline : relâchement après arrêt');
  {
    const bias = { x: 0, y: 0, z: 0 };
    const samples = [];
    for (let i = 0; i < 50; i++) samples.push({ x: noise(0.02), y: noise(0.02), z: RPM33 + noise(0.05) });
    for (let i = 0; i < 40; i++) samples.push({ x: noise(0.02), y: noise(0.02), z: RPM33 + noise(0.05) }); // mesure
    for (let i = 0; i < 40; i++) samples.push({ x: noise(0.05), y: noise(0.05), z: noise(0.05) }); // arrêt
    // la platine relâchée remonte de 0 à 33 en ~1 s (33 échantillons).
    // Rampe SANS bruit : la limite de bande doit rester déterministe
    // (avec du bruit, le dernier échantillon peut tomber juste sous le seuil).
    for (let i = 1; i <= 33; i++) samples.push({ x: 0, y: 0, z: (RPM33 * i) / 33 });
    const r = simulate(samples, bias);
    // la trace commence à l'échantillon 50 : 40 mesure (0-39), 40 arrêt (40-79),
    // remontée physique de la platine à partir de l'index 80 de la trace.
    // La platine réelle entre dans la bande ±6% de 33.33 (~31.3) à un certain
    // index : l'app doit s'accrocher à ~33 IMMÉDIATEMENT après (pas de rampe).
    const bandEntry = r.trace.findIndex((v, i) => {
      const absSpeed = Math.abs((samples[i + 50] ?? {}).z || 0);
      return i >= 80 && absSpeed * RAD2RPM > 31.5;
    });
    const crossed = r.trace.findIndex((v, i) => i >= 80 && v > 32.5);
    const delay = crossed - bandEntry;
    console.log(`     platine physique dans la bande à l'index ${bandEntry}, app accrochée à l'index ${crossed} (retard ${delay} échantillons)`);
    check('relâchement : accrochage IMMÉDIAT (retard <= 1 échantillon)', bandEntry >= 0 && crossed >= 0 && delay <= 1, `retard ${delay}`);
    check('relâchement : valeur finale ~33.3', close(r.trace[r.trace.length - 1], 33.33, 1.0), r.trace[r.trace.length - 1].toFixed(1));
  }

  // --- 7. Constantes ---
  console.log('\n[7] Constantes de calibration');
  check('BIAS_CALIBRATION_MS = 3000 (3 s)', CALIBRATION_TIMINGS.BIAS_CALIBRATION_MS === 3000);
  check('AXIS_CALIBRATION_MS = 1500 (1,5 s)', CALIBRATION_TIMINGS.AXIS_CALIBRATION_MS === 1500);
  check('RELOCK_MIN_RAD_S = 3.0 (~28,6 RPM)', RELOCK_MIN_RAD_S === 3.0);
  check('RELOCK_CONSECUTIVE = 3 échantillons', RELOCK_CONSECUTIVE === 3);
  check('MOTION_SNAP_RPM = 25 (> wobble max ~18, < geste réel)', MOTION_SNAP_RPM === 25, `actuel: ${MOTION_SNAP_RPM}`);

  // --- 7b. Motion snap : seuil cohérent avec le terrain ---
  // Le wobble du rocking observé (ratio 0.79-1.54 = ±37% ≈ ±12 RPM de
  // déviation sur le brut, jusqu'à ~18 RPM avec pics) ne doit PAS franchir
  // MOTION_SNAP_RPM ; un vrai geste (backspin, scratch, poussée franche)
  // le franchit largement.
  console.log('\n[7b] Motion snap (seuil)');
  {
    // rotation stable bruyante : brut 21..45 RPM autour de 33 -> déviation
    // max ~12-18 < 25 -> aucun snap
    const bruts = [];
    for (let i = 0; i < 300; i++) {
      const t = i / 33.33;
      const slip = 0.37 * Math.sin(2 * Math.PI * 0.4 * t);
      bruts.push(33.33 * (1 + slip));
    }
    const maxDev = Math.max(...bruts.map((r) => Math.abs(r - 33.33)));
    console.log(`     wobble max: brut ${Math.min(...bruts).toFixed(1)}..${Math.max(...bruts).toFixed(1)} (déviation max ${maxDev.toFixed(1)} RPM)`);
    check('wobble ±37% : déviation max < 25 (pas de faux snap)', maxDev < MOTION_SNAP_RPM, `${maxDev.toFixed(1)} < ${MOTION_SNAP_RPM}`);
    // backspin à -33 : le brut SIGNÉ passe à -33 pendant que l'estimé est
    // encore à +33 -> écart signé = 66 >> 25 -> snap déclenché
    check('backspin : écart signé brut/estimé >> 25 (snap)', 66 > MOTION_SNAP_RPM);
    // poussée franche 33 -> 60 : écart 27 > 25 -> snap
    check('poussée franche 33->60 : écart 27 > 25 (snap)', 27 > MOTION_SNAP_RPM);
    // pitch léger 33 -> 36 : écart 3 < 25 -> la fenêtre suit (pas de snap)
    check('pitch léger 33->36 : écart 3 < 25 (pas de snap)', 3 < MOTION_SNAP_RPM);
  }

  // --- 8. Ré-accrochage STRICT après arrêt ---
  // L'utilisateur : "quand le plateau est arrêté, je bouge à peine et il me
  // met -17/+17". Un petit geste ne doit RIEN déclencher ; un vrai scratch/sec
  // (>= ~28,6 RPM soutenu) doit accrocher directement.
  console.log('\n[8] Ré-accrochage strict après arrêt');
  {
    // unit : relockStep
    check('relockStep : 2 rad/s (petit geste) -> 0', relockStep(2, 2.0) === 0);
    check('relockStep : 3.5 rad/s (vrai geste) -> incrémente', relockStep(0, 3.5) === 1);
    check('relockStep : sous le seuil remet à 0', relockStep(2, 1.5) === 0);

    // scénario : arrêt puis petit geste (±17 RPM ≈ 1.78 rad/s) pendant 30
    // échantillons -> ne doit PAS ré-accrocher (le lissé reste ~0)
    {
      const bias = { x: 0, y: 0, z: 0 };
      const samples = [];
      for (let i = 0; i < 50; i++) samples.push({ x: noise(0.02), y: noise(0.02), z: RPM33 + noise(0.05) }); // axe
      for (let i = 0; i < 40; i++) samples.push({ x: noise(0.02), y: noise(0.02), z: RPM33 + noise(0.05) }); // mesure
      for (let i = 0; i < 30; i++) samples.push({ x: noise(0.05), y: noise(0.05), z: noise(0.05) });          // arrêt
      // petit geste : le plateau bouge à peine (vitesse qui monte à ~17 RPM max)
      for (let i = 0; i < 30; i++) {
        const s = Math.sin((Math.PI * i) / 30); // 0 -> 1 -> 0
        samples.push({ x: noise(0.05), y: noise(0.05), z: (RPM33 * 0.5) * s + noise(0.05) }); // max ~16,7 RPM
      }
      const r = simulate(samples, bias);
      const end = r.trace[r.trace.length - 1];
      const maxAbs = Math.max(...r.trace.slice(-30).map(Math.abs));
      console.log(`     petit geste : max affiché ${maxAbs.toFixed(1)} RPM, fin ${end.toFixed(1)}`);
      check('petit geste (±17) : pas de faux ré-accrochage (< 3 RPM)', maxAbs < 3, maxAbs.toFixed(1));
      check('petit geste : retombe à ~0 quand on arrête de bouger', close(end, 0, 0.5), end.toFixed(1));
    }

    // scénario : arrêt puis vrai scratch (vitesse soutenue ~33 RPM) -> accroche direct
    {
      const bias = { x: 0, y: 0, z: 0 };
      const samples = [];
      for (let i = 0; i < 50; i++) samples.push({ x: noise(0.02), y: noise(0.02), z: RPM33 + noise(0.05) });
      for (let i = 0; i < 40; i++) samples.push({ x: noise(0.02), y: noise(0.02), z: RPM33 + noise(0.05) });
      for (let i = 0; i < 30; i++) samples.push({ x: noise(0.05), y: noise(0.05), z: noise(0.05) });
      // vrai scratch : montée franche à ~33 RPM maintenue
      for (let i = 0; i < 40; i++) samples.push({ x: noise(0.02), y: noise(0.02), z: RPM33 + noise(0.05) });
      const r = simulate(samples, bias);
      const end = r.trace[r.trace.length - 1];
      // la trace commence à l'échantillon 50 : mesure 40 (0-39) + arrêt 30 (40-69)
      // -> le scratch commence à l'index 70 de la trace. Il doit accrocher en
      // 3 échantillons (relock strict) soit <= 73.
      const firstHigh = r.trace.findIndex((v, i) => i >= 68 && v > 25);
      console.log(`     vrai scratch : premier échantillon > 25 RPM à l'index ${firstHigh}`);
      check('vrai scratch : accroche en <4 échantillons après le début du geste', firstHigh >= 70 && firstHigh <= 73, `index ${firstHigh}`);
      check('vrai scratch : valeur finale ~33.3', close(end, 33.33, 1.5), end.toFixed(1));
    }
  }

  // --- 10. Estimateur de phase : stabilité + sensibilité au pitch ---
  console.log('\n[10] Estimateur de phase (intégrale fenêtrée)');
  {
    const RPM33rad = RPM33; // 33.33 RPM en rad/s
    // a) brut ±35% + pics aléatoires -> la sortie reste stable (33 ± 2)
    {
      const est = createPhaseEstimator({ windowMs: 3500, sampleMs: 50 });
      let t = 0;
      const out = [];
      for (let i = 0; i < 300; i++) {
        t += 50;
        const wobble = 0.35 * Math.sin((2 * Math.PI * i) / 20); // ±35% à ~1 Hz
        const spike = Math.random() < 0.02 ? (Math.random() * 2 - 1) * 1.0 : 0; // pics ±9,5 RPM
        out.push(est.update(RPM33rad * (1 + wobble) + spike, t));
      }
      const last = out.slice(-60);
      const min = Math.min(...last), max = Math.max(...last);
      console.log(`     brut ±35% + pics -> sortie ${min.toFixed(1)}..${max.toFixed(1)} RPM`);
      check('phase : brut ±35% -> stable (33 ± 2)', min > 31 && max < 35, `${min.toFixed(1)}..${max.toFixed(1)}`);
    }
    // b) PITCH 33.33 -> 36 : suivi en quelques secondes
    {
      const est = createPhaseEstimator({ windowMs: 3500, sampleMs: 50 });
      let t = 0;
      let reached = -1;
      const DOT36 = 36 * (2 * Math.PI) / 60;
      for (let i = 0; i < 240; i++) {
        t += 50;
        const v = est.update(i < 80 ? RPM33rad : DOT36, t);
        if (reached < 0 && v > 34.5) reached = i;
      }
      const secs = ((reached * 50) / 1000).toFixed(1);
      console.log(`     pitch 33.33->36 : 34.5 atteint en ${secs} s`);
      check('phase : pitch suivi (34.5 atteint en <6,5 s)', reached >= 0 && reached * 50 / 1000 < 6.5, `${secs} s`);
    }
    // c) snapTo -> sortie immédiate
    {
      const est = createPhaseEstimator({ windowMs: 3500, sampleMs: 50 });
      est.snapTo(20, 1000);
      const v = est.update(RPM33rad, 1050);
      check('phase : snapTo(20) -> ~20 immédiatement', close(v, 20, 1.0), v.toFixed(1));
    }
    // d) backspin signé -> négatif
    {
      const est = createPhaseEstimator({ windowMs: 3500, sampleMs: 50 });
      let t = 0;
      let v = 0;
      for (let i = 0; i < 120; i++) {
        t += 50;
        v = est.update(-RPM33rad, t);
      }
      check('phase : backspin soutenu -> ~-33', v < -30, v.toFixed(1));
    }
  }

  // --- 9. Cadence adaptative de l'envoi (batterie) ---
  console.log('\n[9] Cadence adaptative (speedSender)');
  {
    check('SLOW_INTERVAL_MS = 5000 (5 s à l\'arrêt)', SLOW_INTERVAL_MS === 5000);
    check('SEND_INTERVAL_MS = 30 (33 Hz en rotation)', SEND_INTERVAL_MS === 30, `actuel: ${SEND_INTERVAL_MS}`);

    // vers 127.0.0.1:9 (port fermé) : connexion refusée instantanément,
    // onError est appelé à chaque tick -> on compte les tentatives.
    // setIntervalMs AVANT start : ne doit pas crasher ni créer d'intervalle
    const pre = createSpeedSender(() => 0, { ip: '127.0.0.1', port: 9 });
    pre.setIntervalMs(5000);
    pre.stop();
    check('setIntervalMs avant start : pas de crash', true);

    let tried = 0;
    const sender = createSpeedSender(() => 0, {
      ip: '127.0.0.1',
      port: 9,
      intervalMs: 40,
      onSuccess: () => tried++,
      onError: () => tried++,
    });

    sender.start();
    await new Promise((r) => setTimeout(r, 300)); // laisser le 1er fetch échouer (20 ms)
    const fastTicks = tried;
    check('cadence rapide : des envois partent (échec de connexion = tick)', fastTicks >= 1, `ticks=${fastTicks}`);
    sender.setIntervalMs(30); // changement de cadence en cours de route : pas de crash
    sender.setIntervalMs(2000);
    sender.stop();
    check('setIntervalMs pendant le run : pas de crash', true);
  }

  console.log(`\n===== ${pass} OK / ${fail} ECHEC =====`);
  process.exit(fail === 0 ? 0 : 1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
