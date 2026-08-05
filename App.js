// App.js
// Point d'entrée — se contente de connecter le hook (logique capteurs,
// useRpmSensor.js) au composant d'affichage (RpmDisplay.js). Aucune
// logique de calcul ici.
//
// Installation nécessaire :
//   npx expo install expo-sensors

import React from 'react';
import { useRpmSensor } from './tools/useRpmSensor';
import RpmDisplay from './tools/RpmDisplay';

export default function App() {
  const {
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
    startBiasCalibration,
    startMeasuring,
    stop,
    testSend,
    setStandardSpeed,
  } = useRpmSensor();

  return (
    <RpmDisplay
      phase={phase}
      rpm={rpm}
      rejectedCount={rejectedCount}
      dominantAxisLabel={dominantAxisLabel}
      biasInfo={biasInfo}
      sendStatus={sendStatus}
      sensorError={sensorError}
      gain={gain}
      standardSpeed={standardSpeed}
      stability={stability}
      onSelectSpeed={setStandardSpeed}
      onStartBiasCalibration={startBiasCalibration}
      onStartMeasuring={startMeasuring}
      onStop={stop}
      onTestSend={testSend}
    />
  );
}