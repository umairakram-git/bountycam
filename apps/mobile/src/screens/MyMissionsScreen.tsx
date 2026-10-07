// DISCOVERY.md 3.5: GET /me/missions; tapping one opens Mission through
// section 3.4's check against the view's own policy_hash (D127).
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { apiGet } from '../api/client';
import { asSummaries, rewardText, type BountySummary } from '../scout/views';
import { Header, StatusPill } from './common';
import { stateLabel } from './MyBountiesScreen';
import { styles } from './styles';

/** "Due 14:05" today, "Due 9 Oct, 14:05" on another day. */
export function dueText(iso: string): string | undefined {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return undefined;
  const d = new Date(t);
  const time = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) return 'Due ' + time;
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
    d.getMonth()
  ];
  return 'Due ' + String(d.getDate()) + ' ' + String(month) + ', ' + time;
}

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

  const load = useCallback(() => {
    setNotice(undefined);
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
            if (typeof r.id === 'string' && typeof r.deadline === 'string') map[r.id] = r.deadline;
            if (typeof r.id === 'string' && typeof r.state === 'string') stateMap[r.id] = r.state;
          }
        }
        setDeadlines(map);
        // REVIEW.md section 7: settled missions are listed with their state.
        setStates(stateMap);
      })
      .catch(() => setNotice("Couldn't reach BountyCam. Try again."));
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <View style={styles.screen}>
      <Header
        title="My missions"
        onBack={props.onBack}
        action={{ label: 'Refresh', onPress: load, disabled: props.busy }}
      />
      {notice === undefined ? null : <Text style={styles.notice}>{notice}</Text>}
      {items === undefined && notice === undefined ? <Text style={styles.muted}>Loading…</Text> : null}
      {items !== undefined && items.length === 0 ? (
        <Text style={styles.muted}>No missions yet. Find a bounty near you to start.</Text>
      ) : null}
      <ScrollView style={{ flex: 1 }}>
        {(items ?? []).map((item) => {
          const state = states[item.id];
          const due = state === 'ACCEPTED' ? dueText(deadlines[item.id] ?? '') : undefined;
          return (
            <Pressable
              key={item.id}
              accessibilityRole="button"
              disabled={props.busy}
              onPress={() => props.onOpen(item.id)}
              style={({ pressed }) => [styles.card, pressed ? styles.cardPressed : null]}
            >
              <View style={styles.cardRow}>
                <Text style={styles.cardTitle} numberOfLines={2}>
                  {item.title}
                </Text>
                <Text style={styles.reward}>{rewardText(item.rewardAmount)}</Text>
              </View>
              <View style={[styles.cardRow, { marginTop: 8 }]}>
                {state === undefined ? <View /> : <StatusPill {...stateLabel(state)} />}
                <Text style={styles.muted}>{due ?? ''}</Text>
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}
