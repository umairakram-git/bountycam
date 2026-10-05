// DISCOVERY.md 3.5: GET /me/missions; tapping one opens Mission through
// section 3.4's check against the view's own policy_hash (D127).
import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { apiGet } from '../api/client';
import { asSummaries, rewardText, type BountySummary } from '../scout/views';
import { Button } from './common';
import { styles } from './styles';

export function MyMissionsScreen(props: {
  readonly token: string;
  readonly busy: boolean;
  readonly onOpen: (id: string) => void;
  readonly onBack: () => void;
}): ReactNode {
  const [items, setItems] = useState<readonly BountySummary[] | undefined>(undefined);
  const [deadlines, setDeadlines] = useState<Readonly<Record<string, string>>>({});
  const [states, setStates] = useState<Readonly<Record<string, string>>>({});
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const { token } = props;

  useEffect(() => {
    apiGet(token, '/me/missions')
      .then((result) => {
        if (result.status !== 200) {
          setNotice("Couldn't load your missions (HTTP " + String(result.status) + ').');
          return;
        }
        setItems(asSummaries(result.body, 'missions'));
        const list = (result.body as { missions?: unknown }).missions;
        const map: Record<string, string> = {};
        const stateMap: Record<string, string> = {};
        if (Array.isArray(list)) {
          for (const raw of list) {
            const r = raw as { id?: unknown; deadline?: unknown; state?: unknown };
            if (typeof r.id === 'string' && typeof r.deadline === 'string') {
              map[r.id] = new Date(r.deadline).toLocaleString();
            }
            if (typeof r.id === 'string' && typeof r.state === 'string') stateMap[r.id] = r.state;
          }
        }
        setDeadlines(map);
        // REVIEW.md section 7: settled missions are listed with their state.
        setStates(stateMap);
      })
      .catch(() => setNotice("Couldn't reach BountyCam. Try again."));
  }, [token]);

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>My missions</Text>
      {notice === undefined ? null : <Text style={styles.notice}>{notice}</Text>}
      {items !== undefined && items.length === 0 ? (
        <Text style={styles.muted}>No missions yet.</Text>
      ) : null}
      <ScrollView style={{ flex: 1 }}>
        {(items ?? []).map((item) => (
          <Pressable
            key={item.id}
            accessibilityRole="button"
            disabled={props.busy}
            onPress={() => props.onOpen(item.id)}
            style={styles.row}
          >
            <Text style={styles.value}>{item.title}</Text>
            <Text style={styles.muted}>
              {(states[item.id] ?? '') + ' · ' + rewardText(item.rewardAmount) + ' · due ' +
                (deadlines[item.id] ?? '')}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      <View style={styles.buttons}>
        <Button label="Back" secondary onPress={props.onBack} />
      </View>
    </View>
  );
}
