// DISCOVERY.md 3.2: the public view. Never shows the requester's wallet,
// program_account, or any identifier of the requester.
import { useEffect, useState, type ReactNode } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { apiGet } from '../api/client';
import { aboutKm } from '../scout/location';
import { asPublicBounty, rewardText, type Point, type PublicBounty } from '../scout/views';
import { Button, Header } from './common';
import { categoryLabel, hoursLabel } from './FindScreen';
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
        <Header title="Bounty" onBack={props.onBack} />
        <Text style={styles.notice}>{notice ?? 'Loading…'}</Text>
      </View>
    );
  }
  const hours = bounty.completionWindowSeconds / 3600;
  const distance = aboutKm(props.position, bounty.area);
  const reward = rewardText(bounty.rewardAmount);
  return (
    <View style={styles.screen}>
      <Header title={bounty.title} onBack={props.onBack} />
      <ScrollView style={{ flex: 1 }}>
        <Text style={styles.muted}>{categoryLabel(bounty.category)}</Text>
        <Text style={styles.rewardLarge}>{reward}</Text>
        <Text style={styles.meta}>Held in escrow. Released to you after the requester's review.</Text>

        <Text style={styles.section}>WHERE AND WHEN</Text>
        <View style={styles.card}>
          <Text style={styles.value}>{distance ?? 'Distance unknown'}</Text>
          <Text style={styles.muted}>Exact spot shown after you accept.</Text>
          <Text style={[styles.value, { marginTop: 8 }]}>
            {'Complete within ' + hoursLabel(hours) + ' of accepting'}
          </Text>
        </View>

        <Text style={styles.section}>WHAT YOU'LL DO</Text>
        <View style={styles.card}>
          {bounty.prompts.map((prompt, index) => (
            <Text key={String(index)} style={[styles.value, { marginBottom: 6 }]}>
              {String(index + 1) + '.  ' + prompt}
            </Text>
          ))}
          <Text style={styles.muted}>Each photo is taken in the app, at the location.</Text>
        </View>
      </ScrollView>
      <View style={styles.buttons}>
        <Button label={'Accept · Earn ' + reward} onPress={() => props.onAccept(bounty)} />
      </View>
    </View>
  );
}
