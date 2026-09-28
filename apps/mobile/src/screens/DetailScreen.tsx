// DISCOVERY.md 3.2: the public view. Never shows the requester's wallet,
// program_account, or any identifier of the requester.
import { useEffect, useState, type ReactNode } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { apiGet } from '../api/client';
import { aboutKm } from '../scout/location';
import { asPublicBounty, rewardText, type Point, type PublicBounty } from '../scout/views';
import { Button, Field } from './common';
import { styles } from './styles';

export function DetailScreen(props: {
  readonly token: string;
  readonly id: string;
  readonly position: Point | undefined;
  readonly onAccept: (bounty: PublicBounty) => void;
  readonly onBack: () => void;
}): ReactNode {
  const [bounty, setBounty] = useState<PublicBounty | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const { token, id } = props;

  useEffect(() => {
    apiGet(token, '/bounties/' + id)
      .then((result) => {
        const parsed = result.status === 200 ? asPublicBounty(result.body) : undefined;
        if (parsed === undefined) setNotice('This bounty is no longer available.');
        else setBounty(parsed);
      })
      .catch(() => setNotice("Couldn't reach BountyCam. Try again."));
  }, [token, id]);

  if (bounty === undefined) {
    return (
      <View style={styles.screen}>
        <Text style={styles.title}>Bounty</Text>
        <Text style={styles.notice}>{notice ?? 'Loading…'}</Text>
        <View style={styles.buttons}>
          <Button label="Back" secondary onPress={props.onBack} />
        </View>
      </View>
    );
  }
  const hours = bounty.completionWindowSeconds / 3600;
  const distance = aboutKm(props.position, bounty.area);
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>{bounty.title}</Text>
      <ScrollView style={{ flex: 1 }}>
        <Field label="Category" value={bounty.category} />
        <Field label="Reward" value={rewardText(bounty.rewardAmount)} />
        <Field
          label="Time"
          value={'Complete within ' + String(hours) + (hours === 1 ? ' hour' : ' hours') +
            ' of accepting'}
        />
        <Field
          label="Where"
          value={(distance === undefined ? '' : distance + '. ') +
            'Exact spot shown after you accept.'}
        />
        <Text style={styles.label}>Evidence</Text>
        {bounty.prompts.map((prompt, index) => (
          <Text key={String(index)} style={styles.value}>
            {String(index + 1) + '. ' + prompt}
          </Text>
        ))}
      </ScrollView>
      <View style={styles.buttons}>
        <Button
          label={'Accept — earn ' + rewardText(bounty.rewardAmount)}
          onPress={() => props.onAccept(bounty)}
        />
        <Button label="Back" secondary onPress={props.onBack} />
      </View>
    </View>
  );
}
