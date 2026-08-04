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
  createSmoother,
  autoCorrectGain,
  detectRelease,
  relockStep,
  RELOCK_MIN_RAD_S,
  RELOCK_CONSECUTIVE,
  closestStandard,
  ZERO_DEADBAND_RAD_S,
  CALIBRATION_TIMINGS,
} = await import(`file://${modPath}`);

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
    const smoother = createSmoother();
    let tracker = null;
    let stopCount = 0;
    let releaseAway = false, releaseCount = 0, nearPrev = false;
    let wasStopped = true, relockCount = 0; // ré-accrochage strict (comme le hook)
    const gain = 1.0;
    const trace = [];
    for (const s of corrected.slice(50)) {
      // vitesse AXIALE = |produit scalaire avec l'axe calibré| (comme le hook)
      const dot = s.x * vector.x + s.y * vector.y + s.z * vector.z;
      const absSpeed = Math.abs(dot);
      // détection d'arrêt brutal (comme dans le hook)
      if (tracker !== null && tracker > 1.0 && absSpeed < tracker * 0.1) {
        stopCount += 1;
        if (stopCount >= 2) {
          stopCount = 0;
          tracker = 0;
          smoother.snapTo(0);
          trace.push(0);
          continue;
        }
        trace.push(smoother.ema ?? 0);
        continue;
      }
      stopCount = 0;
      tracker = tracker === null ? absSpeed : 0.35 * absSpeed + 0.65 * tracker;
      // ré-accrochage strict : vrai geste (>= RELOCK_MIN_RAD_S) soutenu 3 échantillons
      if (wasStopped) {
        if (absSpeed < 1.0) {
          smoother.snapTo(0);
          relockCount = 0;
        } else {
          relockCount = relockStep(relockCount, absSpeed);
          if (relockCount >= RELOCK_CONSECUTIVE) {
            smoother.snapTo(absSpeed * RAD2RPM);
            relockCount = 0;
            wasStopped = false;
          }
        }
      } else if (absSpeed < 1.0) {
        wasStopped = true;
        relockCount = 0;
        smoother.snapTo(0);
      }
      const direction = absSpeed < ZERO_DEADBAND_RAD_S ? 0 : dot >= 0 ? 1 : -1;
      let module = smoother.update(absSpeed * RAD2RPM);
      // relâchement : accrochage direct à la standard (comme le hook, sur la vitesse BRUTE)
      const rawRpm = absSpeed * RAD2RPM;
      const { near, rawAway } = detectRelease(module, rawRpm);
      if (releaseAway && near && !nearPrev) {
        smoother.snapTo(closestStandard(rawRpm) / gain);
        module = closestStandard(rawRpm) / gain;
      }
      releaseCount = rawAway ? Math.min(50, releaseCount + 1) : 0;
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
  {
    const bias = { x: 0, y: 0, z: 0 };
    const samples = [];
    for (let i = 0; i < 60; i++) samples.push({ x: noise(0.02), y: noise(0.02), z: RPM33 + noise(0.05) });
    for (let i = 0; i < 60; i++) samples.push({ x: noise(0.02), y: noise(0.02), z: -RPM33 + noise(0.05) });
    const r = simulate(samples, bias);
    const secondHalf = r.trace.slice(60);
    const avgSecondHalf = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
    check('scratch : 2e moitie en negatif', avgSecondHalf < 0, avgSecondHalf.toFixed(1));
    check('scratch : 2e moitie proche de -33', close(avgSecondHalf, -33.33, 3.0), avgSecondHalf.toFixed(1));
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
    // a) 31.5 RPM (sous-comptage classique) -> le gain monte et corrige vers 33.33
    let gain = 1.0;
    for (let i = 0; i < 5000; i++) gain = autoCorrectGain(gain, 31.5);
    check('31.5 RPM -> corrigé vers 33.3', close(31.5 * gain, 33.33, 0.3), `31.5*${gain.toFixed(3)}=${(31.5 * gain).toFixed(1)}`);

    // b) 33.33 exact -> gain stable
    let g2 = 1.0;
    for (let i = 0; i < 5000; i++) g2 = autoCorrectGain(g2, 33.33);
    check('33.33 -> gain inchangé', close(g2, 1.0, 0.01), g2.toFixed(3));

    // c) 45 RPM -> corrigé vers 45 (43 RPM = dans la bande ±6%)
    let g3 = 1.0;
    for (let i = 0; i < 5000; i++) g3 = autoCorrectGain(g3, 43.0);
    check('43 RPM -> corrigé vers 45', close(43 * g3, 45, 0.5), `${(43 * g3).toFixed(1)}`);

    // d) 30 RPM (10% hors bande, décalage volontaire du DJ) -> PAS touché
    let g4 = 1.0;
    for (let i = 0; i < 5000; i++) g4 = autoCorrectGain(g4, 30.0);
    check('30 RPM (hors bande) -> gain inchangé', close(g4, 1.0, 0.001), g4.toFixed(3));

    // e) clamp du gain
    let g5 = 1.2;
    g5 = autoCorrectGain(g5, 33.33);
    check('gain clampé à 1.12 max', g5 <= 1.12, g5.toFixed(3));
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
    // la platine relâchée remonte de 0 à 33 en ~1 s (33 échantillons)
    for (let i = 1; i <= 33; i++) samples.push({ x: noise(0.02), y: noise(0.02), z: (RPM33 * i) / 33 + noise(0.05) });
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

  console.log(`\n===== ${pass} OK / ${fail} ECHEC =====`);
  process.exit(fail === 0 ? 0 : 1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
