// DISCOVERY.md 3.4: shown only after verifyAssignedPolicy passed in App.tsx.
// CAPTURE.md: the Start capture section, below the evidence list.
import { useEffect, useState, type ReactNode } from 'react';
import { Linking, Pressable, ScrollView, Text, View } from 'react-native';

import { apiPostEmpty } from '../api/client';
import { outcomeFor } from '../review/outcome';
import { missionDetails, rewardText } from '../scout/views';
import type { WalletProvider } from '../wallet/types';
import { CaptureSection } from './CaptureSection';
import { Button, Field } from './common';
import { styles } from './styles';

export function MissionScreen(props: {
  readonly view: unknown;
  readonly lat: string;
  readonly lon: string;
  readonly token: string;
  readonly onBack: () => void;
  readonly onMissions: () => void;
  readonly provider: WalletProvider;
  readonly scoutWallet: string;
}): ReactNode {
  // REVIEW.md section 7: a SUBMITTED mission asks the server once, so a payout this phone has
  // not seen is projected; the answer replaces the view only if its policy hash is the same.
  const [view, setView] = useState<unknown>(props.view);
  useEffect(() => {
    const original = props.view as { id?: unknown; state?: unknown; policy_hash?: unknown };
    if (original.state !== 'SUBMITTED' || typeof original.id !== 'string') return;
    apiPostEmpty(props.token, '/bounties/' + original.id + '/settlement')
      .then((r) => {
        const fresh = r.body as { policy_hash?: unknown } | undefined;
        if (r.status === 200 && fresh?.policy_hash === original.policy_hash) setView(r.body);
      })
      .catch(() => undefined);
  }, [props.token, props.view]);
  const outcome = outcomeFor(view, 'scout');
  const m = missionDetails(view);
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
        {outcome === null ? null : (
          <View>
            <Text style={styles.value}>{outcome.line}</Text>
            {outcome.explorerUrl === undefined ? null : (
              <Pressable
                accessibilityRole="link"
                onPress={() => void Linking.openURL(outcome.explorerUrl as string)}
              >
                <Text style={styles.label}>View on Solana Explorer</Text>
              </Pressable>
            )}
          </View>
        )}
        {outcome !== null ? null : <CaptureSection
          token={props.token}
          bountyId={m.id}
          lat={props.lat}
          lon={props.lon}
          radiusM={m.captureRadiusM}
          onMissions={props.onMissions}
          provider={props.provider}
          view={view}
          scoutWallet={props.scoutWallet}
        />}
      </ScrollView>
      <View style={styles.buttons}>
        <Button label="Back" secondary onPress={props.onBack} />
      </View>
    </View>
  );
}
