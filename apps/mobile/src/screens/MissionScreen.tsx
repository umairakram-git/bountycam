// DISCOVERY.md 3.4: shown only after verifyAssignedPolicy passed in App.tsx.
// CAPTURE.md: the Start capture section, below the evidence list.
import { useEffect, useState, type ReactNode } from 'react';
import { Linking, Pressable, ScrollView, Text, View } from 'react-native';

import { apiPostEmpty } from '../api/client';
import { outcomeFor } from '../review/outcome';
import { missionDetails, rewardText } from '../scout/views';
import type { WalletProvider } from '../wallet/types';
import { CaptureSection } from './CaptureSection';
import { Header, StatusPill } from './common';
import { stateLabel } from './MyBountiesScreen';
import { dueText } from './MyMissionsScreen';
import { styles } from './styles';

function get(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

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
  const state = String(get(view, 'state'));
  const kind = get(get(view, 'settlement'), 'kind');
  const reward = rewardText(m.rewardAmount);
  const due = dueText(m.deadline);
  const howPaid =
    kind === 'APPROVED'
      ? 'The requester approved your evidence.'
      : kind === 'RELEASED'
        ? 'Released automatically after the review time.'
        : kind === 'RESOLVED_PAID'
          ? 'The arbiter paid you.'
          : '';
  const mapsUrl = 'geo:' + props.lat + ',' + props.lon + '?q=' + props.lat + ',' + props.lon;
  return (
    <View style={styles.screen}>
      <Header title={m.title} onBack={props.onBack} />
      <ScrollView style={{ flex: 1 }}>
        <View style={[styles.cardRow, { marginBottom: 8 }]}>
          <StatusPill {...stateLabel(state)} />
          <Text style={styles.reward}>{reward}</Text>
        </View>

        {state === 'PAID' ? (
          <View style={[styles.card, { borderColor: '#2f6b4c' }]}>
            <Text style={styles.meta}>✓ Evidence accepted</Text>
            <Text style={styles.rewardLarge}>{'You earned ' + reward}</Text>
            <Text style={styles.muted}>{howPaid}</Text>
            {outcome?.explorerUrl === undefined ? null : (
              <View>
                <Text style={styles.value}>✓ Settled on Solana</Text>
                <Pressable
                  accessibilityRole="link"
                  onPress={() => void Linking.openURL(outcome.explorerUrl as string)}
                  style={{ paddingVertical: 8 }}
                >
                  <Text style={styles.headerActionLabel}>View transaction ›</Text>
                </Pressable>
              </View>
            )}
          </View>
        ) : outcome === null ? null : (
          <View style={styles.card}>
            <Text style={styles.value}>{outcome.line}</Text>
            {outcome.explorerUrl === undefined ? null : (
              <Pressable
                accessibilityRole="link"
                onPress={() => void Linking.openURL(outcome.explorerUrl as string)}
                style={{ paddingVertical: 8 }}
              >
                <Text style={styles.headerActionLabel}>View transaction ›</Text>
              </Pressable>
            )}
          </View>
        )}

        {outcome !== null ? null : (
          <View>
            <Text style={styles.section}>WHERE AND WHEN</Text>
            <View style={styles.card}>
              <Text style={styles.value}>{'Spot: ' + props.lat + ', ' + props.lon}</Text>
              <Pressable
                accessibilityRole="link"
                onPress={() => void Linking.openURL(mapsUrl).catch(() => undefined)}
                style={{ paddingVertical: 8 }}
              >
                <Text style={styles.headerActionLabel}>Open in Maps ›</Text>
              </Pressable>
              {due === undefined ? null : <Text style={styles.value}>{due}</Text>}
            </View>
          </View>
        )}

        <Text style={styles.section}>{outcome === null ? "WHAT YOU'LL DO" : 'THE TASK'}</Text>
        <View style={styles.card}>
          {m.prompts.map((prompt, index) => (
            <Text key={String(index)} style={[styles.value, { marginBottom: 6 }]}>
              {String(index + 1) + '.  ' + prompt}
            </Text>
          ))}
        </View>

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
    </View>
  );
}
