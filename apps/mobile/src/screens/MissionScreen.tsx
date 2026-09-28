// DISCOVERY.md 3.4: shown only after verifyAssignedPolicy passed in App.tsx.
import type { ReactNode } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { missionDetails, rewardText } from '../scout/views';
import { Button, Field } from './common';
import { styles } from './styles';

export function MissionScreen(props: {
  readonly view: unknown;
  readonly lat: string;
  readonly lon: string;
  readonly onBack: () => void;
}): ReactNode {
  const m = missionDetails(props.view);
  const deadline = m.deadline === '' ? '' : new Date(m.deadline).toLocaleString();
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Accepted.</Text>
      <ScrollView style={{ flex: 1 }}>
        <Field label="Mission" value={m.title} />
        <Field label="Reward" value={rewardText(m.rewardAmount)} />
        <Field label="Deadline" value={deadline} />
        <Field label="Exact spot" value={props.lat + ', ' + props.lon} />
        <Text style={styles.label}>Evidence</Text>
        {m.prompts.map((prompt, index) => (
          <Text key={String(index)} style={styles.value}>
            {String(index + 1) + '. ' + prompt}
          </Text>
        ))}
        <Text style={styles.notice}>Capture opens in a later version.</Text>
      </ScrollView>
      <View style={styles.buttons}>
        <Button label="Back" secondary onPress={props.onBack} />
      </View>
    </View>
  );
}
