// DISCOVERY.md 3.1: one location fix, one discovery query, a list. Each card is
// filled in from the public view (GET /bounties/:id) for its evidence count and
// time limit; a card whose view fails still shows title, reward and distance.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Linking, Pressable, ScrollView, Text, View } from 'react-native';

import { apiGet } from '../api/client';
import { DISCOVERY_LIMIT, DISCOVERY_RADIUS_M } from '../config';
import { aboutKm, currentPosition } from '../scout/location';
import {
  asPublicBounty,
  asSummaries,
  rewardText,
  type BountySummary,
  type Point,
} from '../scout/views';
import { Button, Header } from './common';
import { styles } from './styles';

interface CardExtra {
  readonly photos: number;
  readonly hours: number;
}

export function categoryLabel(category: string): string {
  return category.length === 0 ? category : category[0]!.toUpperCase() + category.slice(1);
}

export function hoursLabel(hours: number): string {
  return String(hours) + (hours === 1 ? ' hour' : ' hours');
}

function totalReward(items: readonly BountySummary[]): string | undefined {
  let sum = 0n;
  for (const item of items) {
    if (!/^[0-9]+$/.test(item.rewardAmount)) return undefined;
    sum += BigInt(item.rewardAmount);
  }
  return rewardText(String(sum));
}

export function FindScreen(props: {
  readonly token: string;
  readonly onOpen: (id: string, position: Point | undefined) => void;
  readonly onBack: () => void;
}): ReactNode {
  const [items, setItems] = useState<readonly BountySummary[] | undefined>(undefined);
  const [extras, setExtras] = useState<Readonly<Record<string, CardExtra>>>({});
  const [position, setPosition] = useState<Point | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [denied, setDenied] = useState(false);
  const [loading, setLoading] = useState(false);
  const { token } = props;

  const load = useCallback(async () => {
    setLoading(true);
    setNotice(undefined);
    setDenied(false);
    setItems(undefined);
    setExtras({});
    try {
      const fix = await currentPosition();
      if (!fix.ok) {
        if (fix.kind === 'DENIED') {
          setDenied(true);
          setNotice(
            'BountyCam needs your location to find bounties near you. Open Settings to allow it.',
          );
        } else {
          setNotice("Couldn't find your location. Try again.");
        }
        return;
      }
      setPosition(fix.point);
      const path =
        '/bounties?lat=' + fix.lat + '&lon=' + fix.lon +
        '&radius_m=' + String(DISCOVERY_RADIUS_M) + '&limit=' + String(DISCOVERY_LIMIT);
      const result = await apiGet(token, path);
      if (result.status !== 200) {
        setNotice("Couldn't load bounties (HTTP " + String(result.status) + ').');
        return;
      }
      const list = asSummaries(result.body, 'bounties');
      setItems(list);
      for (const item of list) {
        apiGet(token, '/bounties/' + item.id)
          .then((detail) => {
            const view = detail.status === 200 ? asPublicBounty(detail.body) : undefined;
            if (view === undefined) return;
            setExtras((previous) => ({
              ...previous,
              [item.id]: {
                photos: view.prompts.length,
                hours: view.completionWindowSeconds / 3600,
              },
            }));
          })
          .catch(() => undefined);
      }
    } catch {
      setNotice("Couldn't reach BountyCam. Try again.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const total = items === undefined ? undefined : totalReward(items);
  return (
    <View style={styles.screen}>
      <Header
        title="Bounties near you"
        onBack={props.onBack}
        action={{ label: 'Refresh', onPress: () => void load(), disabled: loading }}
      />
      {notice === undefined ? null : <Text style={styles.notice}>{notice}</Text>}
      {items === undefined && notice === undefined ? (
        <Text style={styles.muted}>Finding your location…</Text>
      ) : null}
      {items !== undefined && items.length === 0 ? (
        <Text style={styles.muted}>No bounties near you right now. Tap Refresh to check again.</Text>
      ) : null}
      {items !== undefined && items.length > 0 ? (
        <Text style={styles.muted}>
          {String(items.length) + (items.length === 1 ? ' bounty' : ' bounties') +
            (total === undefined ? '' : ' · ' + total + ' available')}
        </Text>
      ) : null}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingTop: 8 }}>
        {(items ?? []).map((item) => {
          const extra = extras[item.id];
          const distance = aboutKm(position, item.area);
          const meta = [
            distance,
            extra === undefined ? undefined : String(extra.photos) + (extra.photos === 1 ? ' photo' : ' photos'),
            extra === undefined ? undefined : String(extra.hours) + ' h to complete',
          ].filter((part): part is string => part !== undefined);
          return (
            <Pressable
              key={item.id}
              accessibilityRole="button"
              accessibilityLabel={item.title + ', ' + rewardText(item.rewardAmount)}
              onPress={() => props.onOpen(item.id, position)}
              style={({ pressed }) => [styles.card, pressed ? styles.cardPressed : null]}
            >
              <View style={styles.cardRow}>
                <Text style={styles.cardTitle} numberOfLines={2}>
                  {item.title}
                </Text>
                <Text style={styles.reward}>{rewardText(item.rewardAmount)}</Text>
              </View>
              <Text style={styles.muted}>{categoryLabel(item.category)}</Text>
              {meta.length === 0 ? null : <Text style={styles.meta}>{meta.join('  ·  ')}</Text>}
            </Pressable>
          );
        })}
      </ScrollView>
      {denied ? (
        <View style={styles.buttons}>
          <Button label="Open Settings" onPress={() => void Linking.openSettings()} />
        </View>
      ) : null}
    </View>
  );
}
