// The fixed job rules (D122 ruling 3), read from the same constants the create
// request uses, in plain words. Assurance is not shown (D146 ruling 3).
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';

import { FIXED_POLICY } from '../create/defaults';
import { styles } from './styles';

function hours(seconds: number): string {
  const h = seconds / 3600;
  return String(h) + (h === 1 ? ' hour' : ' hours');
}

export const JOB_RULES: readonly string[] = [
  'Photos taken within ' + String(FIXED_POLICY.capture_radius_m) + ' m of the spot',
  'Open to Scouts for ' + hours(FIXED_POLICY.acceptance_window_seconds),
  'Scout has ' + hours(FIXED_POLICY.completion_window_seconds) + ' to complete',
  'You have ' + hours(FIXED_POLICY.challenge_window_seconds) +
    ' to review; after that, payment releases automatically',
];

export function JobRules(): ReactNode {
  return (
    <View style={styles.card}>
      {JOB_RULES.map((rule) => (
        <Text key={rule} style={[styles.value, { marginBottom: 6 }]}>
          {'•  ' + rule}
        </Text>
      ))}
    </View>
  );
}
