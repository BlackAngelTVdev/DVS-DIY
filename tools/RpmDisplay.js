// RpmDisplay.js
// Interface du compte-tours DVS. Purement visuel : reçoit tout en props,
// ne fait aucun calcul, ne touche à aucun capteur.
//
// Version épurée : pas de platine animée, tout le contenu est remonté et
// le gros chiffre RPM est au centre.

import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, Pressable, Easing } from 'react-native';
import { SERVER_IP } from './speedSender';
import { closestStandard } from './calibration';

const C = {
  bg: '#08080d',
  panel: '#12121c',
  panel2: '#1a1a28',
  border: '#262636',
  cyan: '#00e5ff',
  magenta: '#ff2d78',
  green: '#2ee6a8',
  amber: '#ffb020',
  red: '#ff5252',
  text: '#f4f4ff',
  dim: '#8a8aa3',
  faint: '#55556b',
};

// --- Pastille d'état lumineuse ---
function Dot({ color, pulse }) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!pulse) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(anim, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [anim, pulse]);
  const opacity = anim.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] });
  return <Animated.View style={[styles.dot, { backgroundColor: color, opacity: pulse ? opacity : 1 }]} />;
}

// --- Barre de progression (calibration) ---
function ProgressBar() {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(anim, { toValue: 1, duration: 1300, easing: Easing.inOut(Easing.quad), useNativeDriver: false })
    );
    loop.start();
    return () => loop.stop();
  }, [anim]);
  const translate = anim.interpolate({ inputRange: [0, 1], outputRange: [-120, 260] });
  return (
    <View style={styles.progressTrack}>
      <Animated.View style={[styles.progressFill, { transform: [{ translateX: translate }] }]} />
    </View>
  );
}

// --- Bouton stylé ---
function NeoButton({ title, onPress, kind = 'primary', disabled }) {
  const palette = {
    primary: { bg: C.cyan, fg: '#001014' },
    danger: { bg: C.magenta, fg: '#fff' },
    outline: { bg: 'transparent', fg: C.cyan, border: C.cyan },
  }[kind];
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.btn,
        { backgroundColor: palette.bg, borderColor: palette.border || palette.bg },
        pressed && !disabled && styles.btnPressed,
        disabled && styles.btnDisabled,
      ]}
    >
      <Text style={[styles.btnText, { color: palette.fg }, disabled && styles.btnTextDisabled]}>{title}</Text>
    </Pressable>
  );
}

// --- Étape du stepper ---
function Step({ n, label, active, done }) {
  return (
    <View style={styles.step}>
      <View style={[styles.stepDot, active && styles.stepDotActive, done && styles.stepDotDone]}>
        {done ? <Text style={styles.stepCheck}>✓</Text> : <Text style={[styles.stepNum, active && styles.stepNumActive]}>{n}</Text>}
      </View>
      <Text style={[styles.stepLabel, active && styles.stepLabelActive]}>{label}</Text>
    </View>
  );
}

// --- Petite carte de stats ---
function Stat({ label, value, color }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, { color: color || C.text }]} numberOfLines={1}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

export default function RpmDisplay({
  phase,
  rpm,
  rejectedCount,
  dominantAxisLabel,
  biasInfo,
  sendStatus,
  sensorError,
  gain,
  onStartBiasCalibration,
  onStartMeasuring,
  onStop,
  onTestSend,
}) {
  const isMeasuring = phase === 'measuring';
  const calibrating = phase === 'calibratingBias' || phase === 'calibratingAxis';
  const isBack = rpm < -0.5;
  const dirColor = isBack ? C.magenta : isMeasuring ? C.cyan : C.dim;

  const steps = [
    { n: 1, label: 'Biais', done: phase !== 'idle' && phase !== 'calibratingBias', active: phase === 'calibratingBias' },
    { n: 2, label: 'Axe', done: isMeasuring, active: phase === 'calibratingAxis' },
    { n: 3, label: 'Mesure', done: false, active: isMeasuring },
  ];
  if (phase === 'readyToSpin') steps[2].done = true;

  return (
    <View style={styles.container}>
      {/* en-tête */}
      <View style={styles.header}>
        <View style={styles.brand}>
          <Text style={styles.brandTitle}>PHASE <Text style={{ color: C.cyan }}>DVS</Text></Text>
          <Text style={styles.brandSub}>compte-tours vinyle</Text>
        </View>
        <View style={styles.headerRight}>
          <Dot color={sendStatus === 'ok' ? C.green : sendStatus === 'error' ? C.red : C.faint} pulse={isMeasuring} />
          <Text style={styles.headerIp}>{SERVER_IP}</Text>
        </View>
      </View>

      {/* affichage RPM — élément principal */}
      <View style={styles.readout}>
        <Text style={[styles.rpmValue, { color: dirColor }]}>
          {isMeasuring ? rpm.toFixed(1) : '--.-'}
        </Text>
        <Text style={styles.rpmUnit}>TOURS / MINUTE</Text>

        <View style={[styles.badge, { borderColor: dirColor }]}>
          <Text style={[styles.badgeText, { color: dirColor }]}>
            {isBack ? '⟲ BACKSPIN' : isMeasuring ? 'MARCHE AVANT' : calibrating ? 'CALIBRATION…' : 'PRÊT'}
          </Text>
        </View>

        {isMeasuring && rpm > 0 && (
          <Text style={styles.hint}>
            cible : {closestStandard(rpm).toFixed(1)} RPM {Math.abs(rpm - closestStandard(rpm)) < 1.5 ? '· stable' : '· en stabilisation'}
          </Text>
        )}
      </View>

      {/* stepper de phases */}
      <View style={styles.stepper}>
        {steps.map((s, i) => (
          <View key={s.n} style={styles.stepRow}>
            {i > 0 && <View style={[styles.stepLine, (s.done || steps[i - 1].done) && styles.stepLineDone]} />}
            <Step {...s} />
          </View>
        ))}
      </View>

      {/* barre de progression pendant les calibrations */}
      {calibrating && (
        <View style={styles.progressBlock}>
          <ProgressBar />
          <Text style={styles.progressText}>
            {phase === 'calibratingBias'
              ? 'Téléphone immobile, ne bouge pas…'
              : 'Détection de l’axe de rotation…'}
          </Text>
        </View>
      )}

      {/* carte d'état */}
      <View style={styles.statsCard}>
        <Stat label="Gain" value={isMeasuring ? `${(gain * 100).toFixed(0)}%` : '—'} color={C.cyan} />
        <Stat label="Axe" value={dominantAxisLabel || '—'} color={C.amber} />
        <Stat label="Rejets" value={String(rejectedCount)} color={C.dim} />
        <Stat
          label="Serveur"
          value={sendStatus === 'ok' ? 'OK ✓' : sendStatus === 'error' ? 'ERREUR' : '—'}
          color={sendStatus === 'ok' ? C.green : sendStatus === 'error' ? C.red : C.dim}
        />
      </View>

      {biasInfo && phase !== 'calibratingBias' && (
        <Text style={styles.biasText}>
          biais x:{biasInfo.x.toFixed(3)} y:{biasInfo.y.toFixed(3)} z:{biasInfo.z.toFixed(3)}
        </Text>
      )}
      {sensorError && <Text style={styles.errorText}>⚠️ {sensorError}</Text>}

      {/* actions */}
      <View style={styles.actions}>
        {phase === 'idle' && (
          <NeoButton title="①  Calibrer le capteur" onPress={onStartBiasCalibration} kind="primary" />
        )}
        {phase === 'readyToSpin' && (
          <NeoButton title="②  Démarrer la mesure" onPress={onStartMeasuring} kind="primary" />
        )}
        {(phase === 'calibratingAxis' || isMeasuring) && (
          <NeoButton title="■ Arrêter" onPress={onStop} kind="danger" />
        )}
        {(phase === 'idle' || phase === 'readyToSpin') && (
          <View style={styles.testRow}>
            <NeoButton title="Tester l’envoi (ratio 1.0)" onPress={onTestSend} kind="outline" />
          </View>
        )}
      </View>

      {/* instructions */}
      <Text style={styles.instructions}>
        {phase === 'idle' &&
          "Pose le téléphone immobile (table, pas la platine) puis appuie sur Calibrer."}
        {phase === 'readyToSpin' &&
          "Colle le téléphone sur la platine, lance la rotation en MARCHE AVANT, PUIS appuie sur Démarrer."}
        {(phase === 'calibratingAxis' || isMeasuring) &&
          'Laisse tourner : la vitesse se stabilise et se recale toute seule sur 33.3 / 45 RPM.'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: C.bg,
    paddingHorizontal: 22,
    paddingTop: 48,
    paddingBottom: 20,
    alignItems: 'center',
  },
  header: {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  brandTitle: {
    color: C.text,
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: 2,
  },
  brandSub: {
    color: C.faint,
    fontSize: 11,
    letterSpacing: 1,
    marginTop: 2,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerIp: {
    color: C.dim,
    fontSize: 12,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  readout: {
    alignItems: 'center',
    marginVertical: 12,
  },
  rpmValue: {
    fontSize: 112,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
    letterSpacing: -2,
  },
  rpmUnit: {
    color: C.dim,
    fontSize: 12,
    letterSpacing: 3,
    marginTop: -8,
  },
  badge: {
    marginTop: 8,
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 5,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.5,
  },
  hint: {
    color: C.faint,
    fontSize: 12,
    marginTop: 8,
  },
  stepper: {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'center',
    marginBottom: 10,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  stepLine: {
    width: 34,
    height: 2,
    backgroundColor: C.faint,
    marginHorizontal: 4,
  },
  stepLineDone: {
    backgroundColor: C.green,
  },
  step: {
    alignItems: 'center',
  },
  stepDot: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    borderColor: C.faint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepDotActive: {
    borderColor: C.cyan,
  },
  stepDotDone: {
    borderColor: C.green,
    backgroundColor: C.green,
  },
  stepNum: {
    color: C.faint,
    fontSize: 12,
    fontWeight: '700',
  },
  stepNumActive: {
    color: C.cyan,
  },
  stepCheck: {
    color: '#00140c',
    fontSize: 13,
    fontWeight: '800',
  },
  stepLabel: {
    color: C.faint,
    fontSize: 10,
    marginTop: 4,
    letterSpacing: 1,
  },
  stepLabelActive: {
    color: C.cyan,
  },
  progressBlock: {
    width: '100%',
    alignItems: 'center',
    marginBottom: 10,
  },
  progressTrack: {
    width: '100%',
    height: 4,
    borderRadius: 2,
    backgroundColor: C.panel2,
    overflow: 'hidden',
  },
  progressFill: {
    width: 120,
    height: 4,
    borderRadius: 2,
    backgroundColor: C.cyan,
  },
  progressText: {
    color: C.amber,
    fontSize: 12,
    marginTop: 6,
  },
  statsCard: {
    width: '100%',
    flexDirection: 'row',
    backgroundColor: C.panel,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: C.border,
    paddingVertical: 10,
    marginBottom: 8,
  },
  stat: {
    flex: 1,
    alignItems: 'center',
  },
  statValue: {
    fontSize: 16,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  statLabel: {
    color: C.faint,
    fontSize: 10,
    marginTop: 2,
    letterSpacing: 1,
  },
  biasText: {
    color: C.faint,
    fontSize: 10,
    marginBottom: 4,
  },
  errorText: {
    color: C.red,
    fontSize: 12,
    marginBottom: 6,
    textAlign: 'center',
  },
  actions: {
    width: '100%',
    alignItems: 'center',
    marginTop: 4,
  },
  testRow: {
    marginTop: 10,
    width: '100%',
  },
  btn: {
    width: '100%',
    borderRadius: 14,
    borderWidth: 1,
    paddingVertical: 14,
    alignItems: 'center',
  },
  btnPressed: {
    opacity: 0.7,
    transform: [{ scale: 0.98 }],
  },
  btnDisabled: {
    opacity: 0.4,
  },
  btnText: {
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  btnTextDisabled: {
    color: C.faint,
  },
  instructions: {
    color: C.dim,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 12,
    paddingHorizontal: 12,
    lineHeight: 18,
  },
});
